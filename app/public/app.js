const MAX_WIDTH = 384;
const BLE_CONFIG = {
  serviceUuid: "9f4d0001-8f5d-4f4c-8d3d-4f747072696e",
  writeCharacteristicUuid: "9f4d0002-8f5d-4f4c-8d3d-4f747072696e",
  notifyCharacteristicUuid: "9f4d0003-8f5d-4f4c-8d3d-4f747072696e"
};
const PACKET_TYPE = {
  TRANSFER_START: 0x01,
  DATA_CHUNK: 0x02,
  TRANSFER_COMMIT: 0x03,
  RESET: 0x04,
  ACK: 0x05,
  ERROR: 0x06
};
const PACKET_TYPE_NAME = new Map([
  [PACKET_TYPE.TRANSFER_START, "transfer-start"],
  [PACKET_TYPE.DATA_CHUNK, "data-chunk"],
  [PACKET_TYPE.TRANSFER_COMMIT, "transfer-commit"],
  [PACKET_TYPE.RESET, "reset"],
  [PACKET_TYPE.ACK, "ack"],
  [PACKET_TYPE.ERROR, "error"]
]);
const PROTOCOL_ERROR_NAME = new Map([
  [0x00, "none"],
  [0x01, "malformed-packet"],
  [0x02, "invalid-packet-type"],
  [0x03, "invalid-envelope"],
  [0x04, "out-of-memory"],
  [0x05, "unexpected-transfer"],
  [0x06, "unexpected-sequence"],
  [0x07, "unexpected-state"],
  [0x08, "payload-length-mismatch"],
  [0x09, "payload-overflow"],
  [0x0a, "transfer-incomplete"]
]);
const PACKET_HEADER_SIZE = 9;
const IMAGE_ENVELOPE_SIZE = 10;
const ACK_PAYLOAD_SIZE = 8;
const ERROR_PAYLOAD_SIZE = 8;
const MAX_ATT_PAYLOAD = 244;
const MAX_DATA_PAYLOAD = MAX_ATT_PAYLOAD - PACKET_HEADER_SIZE;
const ACK_TIMEOUT_MS = 10000;

const state = {
  fileName: "",
  image: null,
  sourceWidth: 0,
  sourceHeight: 0,
  render: {
    envelope: null,
    packedBitmap: null,
    rowsPerChunk: 0,
    chunkPayloadBytes: 0,
    chunkCount: 0,
    algorithm: "atkinson"
  },
  ble: {
    supported: typeof navigator !== "undefined" && "bluetooth" in navigator,
    device: null,
    writeCharacteristic: null,
    notifyCharacteristic: null,
    connected: false,
    busy: false,
    pendingAck: null,
    progressBytes: 0,
    progressChunks: 0,
    transferId: 0
  }
};
const ui = {};

function clampDimension(value) {
  if (!Number.isFinite(value)) {
    return MAX_WIDTH;
  }

  return Math.max(1, Math.min(MAX_WIDTH, Math.round(value)));
}

function calculateStrideBytes(width) {
  return Math.ceil(width / 8);
}

function calculateRowsPerChunk(strideBytes) {
  return Math.max(1, Math.floor(MAX_DATA_PAYLOAD / strideBytes));
}

function buildEnvelope(width, height) {
  const strideBytes = calculateStrideBytes(width);

  return {
    width,
    height,
    strideBytes,
    payloadLength: strideBytes * height
  };
}

function buildChunkPlan(envelope) {
  const rowsPerChunk = calculateRowsPerChunk(envelope.strideBytes);
  const chunkPayloadBytes = rowsPerChunk * envelope.strideBytes;
  const chunkCount = Math.ceil(envelope.payloadLength / chunkPayloadBytes);

  return {
    rowsPerChunk,
    chunkPayloadBytes,
    chunkCount
  };
}

function calculateTargetSize(sourceWidth, sourceHeight, requestedWidth) {
  const width = clampDimension(requestedWidth);
  const height = Math.max(1, Math.round((sourceHeight * width) / sourceWidth));

  return { width, height };
}

function loadImageFromFile(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();

    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };

    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Unable to decode the selected image."));
    };

    image.src = url;
  });
}

function drawSourceToCanvas(image, canvas, width, height, bgColor) {
  const context = canvas.getContext("2d");

  if (!context) {
    throw new Error("2D canvas context is unavailable.");
  }

  canvas.width = width;
  canvas.height = height;
  context.imageSmoothingEnabled = true;
  context.fillStyle = bgColor;
  context.fillRect(0, 0, width, height);
  context.drawImage(image, 0, 0, width, height);
}

function toGrayscale(imageData) {
  const pixels = imageData.data;
  const grayscale = new Float32Array(imageData.width * imageData.height);

  for (let index = 0; index < grayscale.length; index += 1) {
    const pixelOffset = index * 4;
    const red = pixels[pixelOffset];
    const green = pixels[pixelOffset + 1];
    const blue = pixels[pixelOffset + 2];

    grayscale[index] = red * 0.299 + green * 0.587 + blue * 0.114;
  }

  return grayscale;
}

function applyBrightnessContrast(grayscale, brightness, contrast) {
  const shift = brightness * 1.28;
  const factor = contrast >= 0 ? 1 + contrast / 50 : 1 + contrast / 100;
  const result = new Float32Array(grayscale.length);

  for (let i = 0; i < grayscale.length; i += 1) {
    const adjusted = (grayscale[i] - 128) * factor + 128 + shift;
    result[i] = adjusted < 0 ? 0 : adjusted > 255 ? 255 : adjusted;
  }

  return result;
}

function thresholdDither(grayscale, width, height, threshold) {
  const output = new Uint8ClampedArray(width * height);

  for (let index = 0; index < grayscale.length; index += 1) {
    output[index] = grayscale[index] >= threshold ? 255 : 0;
  }

  return output;
}

function orderedDither(grayscale, width, height) {
  const matrix = [
    [0, 8, 2, 10],
    [12, 4, 14, 6],
    [3, 11, 1, 9],
    [15, 7, 13, 5]
  ];
  const output = new Uint8ClampedArray(width * height);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      const threshold = ((matrix[y % 4][x % 4] + 0.5) / 16) * 255;
      output[index] = grayscale[index] >= threshold ? 255 : 0;
    }
  }

  return output;
}

function diffuseError(buffer, width, height, x, y, error, factor) {
  if (x < 0 || x >= width || y < 0 || y >= height) {
    return;
  }

  const index = y * width + x;
  buffer[index] += error * factor;
}

function floydSteinbergDither(grayscale, width, height) {
  const buffer = Float32Array.from(grayscale);
  const output = new Uint8ClampedArray(width * height);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      const oldValue = buffer[index];
      const newValue = oldValue >= 128 ? 255 : 0;
      const error = oldValue - newValue;

      output[index] = newValue;

      diffuseError(buffer, width, height, x + 1, y, error, 7 / 16);
      diffuseError(buffer, width, height, x - 1, y + 1, error, 3 / 16);
      diffuseError(buffer, width, height, x, y + 1, error, 5 / 16);
      diffuseError(buffer, width, height, x + 1, y + 1, error, 1 / 16);
    }
  }

  return output;
}

function atkinsonDither(grayscale, width, height) {
  const buffer = Float32Array.from(grayscale);
  const output = new Uint8ClampedArray(width * height);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      const oldValue = buffer[index];
      const newValue = oldValue >= 128 ? 255 : 0;
      const error = oldValue - newValue;

      output[index] = newValue;

      diffuseError(buffer, width, height, x + 1, y, error, 1 / 8);
      diffuseError(buffer, width, height, x + 2, y, error, 1 / 8);
      diffuseError(buffer, width, height, x - 1, y + 1, error, 1 / 8);
      diffuseError(buffer, width, height, x, y + 1, error, 1 / 8);
      diffuseError(buffer, width, height, x + 1, y + 1, error, 1 / 8);
      diffuseError(buffer, width, height, x, y + 2, error, 1 / 8);
    }
  }

  return output;
}

function ditherImage(grayscale, width, height, algorithm, threshold) {
  switch (algorithm) {
    case "atkinson":
      return atkinsonDither(grayscale, width, height);
    case "ordered":
      return orderedDither(grayscale, width, height);
    case "threshold":
      return thresholdDither(grayscale, width, height, threshold);
    default:
      return floydSteinbergDither(grayscale, width, height);
  }
}

function renderBinaryPreview(canvas, width, height, values) {
  const context = canvas.getContext("2d");

  if (!context) {
    throw new Error("2D canvas context is unavailable.");
  }

  canvas.width = width;
  canvas.height = height;

  const imageData = context.createImageData(width, height);

  for (let index = 0; index < values.length; index += 1) {
    const outputOffset = index * 4;
    const value = values[index];
    imageData.data[outputOffset] = value;
    imageData.data[outputOffset + 1] = value;
    imageData.data[outputOffset + 2] = value;
    imageData.data[outputOffset + 3] = 255;
  }

  context.putImageData(imageData, 0, 0);
}

function packMonochrome(values, width, height) {
  const strideBytes = calculateStrideBytes(width);
  const output = new Uint8Array(strideBytes * height);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const pixelValue = values[y * width + x];

      if (pixelValue === 0) {
        const byteIndex = y * strideBytes + Math.floor(x / 8);
        output[byteIndex] |= 1 << (7 - (x % 8));
      }
    }
  }

  return output;
}

function packetTypeName(type) {
  return PACKET_TYPE_NAME.get(type) ?? `0x${type.toString(16).padStart(2, "0")}`;
}

function protocolErrorName(error) {
  return PROTOCOL_ERROR_NAME.get(error) ?? `0x${error.toString(16).padStart(2, "0")}`;
}

function writeUint16Le(target, offset, value) {
  target[offset] = value & 0xff;
  target[offset + 1] = (value >> 8) & 0xff;
}

function writeUint32Le(target, offset, value) {
  target[offset] = value & 0xff;
  target[offset + 1] = (value >> 8) & 0xff;
  target[offset + 2] = (value >> 16) & 0xff;
  target[offset + 3] = (value >> 24) & 0xff;
}

function readUint16Le(source, offset) {
  return source[offset] | (source[offset + 1] << 8);
}

function readUint32Le(source, offset) {
  return (
    source[offset] |
    (source[offset + 1] << 8) |
    (source[offset + 2] << 16) |
    (source[offset + 3] << 24)
  ) >>> 0;
}

function encodeEnvelopePayload(envelope) {
  const payload = new Uint8Array(IMAGE_ENVELOPE_SIZE);
  writeUint16Le(payload, 0, envelope.width);
  writeUint16Le(payload, 2, envelope.height);
  writeUint16Le(payload, 4, envelope.strideBytes);
  writeUint32Le(payload, 6, envelope.payloadLength);
  return payload;
}

function encodePacket(type, transferId, sequence, payload = new Uint8Array()) {
  const packet = new Uint8Array(PACKET_HEADER_SIZE + payload.length);
  packet[0] = type;
  writeUint32Le(packet, 1, transferId >>> 0);
  writeUint16Le(packet, 5, sequence);
  writeUint16Le(packet, 7, payload.length);
  packet.set(payload, PACKET_HEADER_SIZE);
  return packet;
}

function parsePacketHeader(packet) {
  if (!(packet instanceof Uint8Array) || packet.length < PACKET_HEADER_SIZE) {
    return null;
  }

  return {
    type: packet[0],
    transferId: readUint32Le(packet, 1),
    sequence: readUint16Le(packet, 5),
    payloadLength: readUint16Le(packet, 7)
  };
}

function parseAckPacket(packet, header) {
  if (header.payloadLength !== ACK_PAYLOAD_SIZE || packet.length !== PACKET_HEADER_SIZE + ACK_PAYLOAD_SIZE) {
    throw new Error("Malformed ACK packet.");
  }

  const payloadOffset = PACKET_HEADER_SIZE;
  return {
    ...header,
    packetType: packet[payloadOffset],
    transferState: packet[payloadOffset + 1],
    nextSequence: readUint16Le(packet, payloadOffset + 2),
    bytesReceived: readUint32Le(packet, payloadOffset + 4)
  };
}

function parseErrorPacket(packet, header) {
  if (
    header.payloadLength !== ERROR_PAYLOAD_SIZE ||
    packet.length !== PACKET_HEADER_SIZE + ERROR_PAYLOAD_SIZE
  ) {
    throw new Error("Malformed error packet.");
  }

  const payloadOffset = PACKET_HEADER_SIZE;
  return {
    ...header,
    error: packet[payloadOffset],
    packetType: packet[payloadOffset + 1],
    expectedSequence: readUint16Le(packet, payloadOffset + 2),
    bytesReceived: readUint32Le(packet, payloadOffset + 4)
  };
}

function setImageStatus(message) {
  if (ui.status) {
    ui.status.textContent = message;
  }
}

function setBleStatus(message) {
  if (ui.bleStatus) {
    ui.bleStatus.textContent = message;
  }
}

function setSendStatus(message) {
  if (ui.sendStatus) {
    ui.sendStatus.textContent = message;
  }
}

function updateTransportUI() {
  if (!ui.connectBtn) {
    return;
  }

  const hasBitmap = Boolean(state.render.packedBitmap && state.render.envelope);
  ui.connectBtn.disabled = !state.ble.supported || state.ble.connected || state.ble.busy;
  ui.disconnectBtn.disabled = !state.ble.connected || state.ble.busy;
  ui.sendBtn.disabled = !state.ble.connected || !hasBitmap || state.ble.busy;

  if (ui.sendProgress) {
    const totalBytes = state.render.envelope?.payloadLength ?? 0;
    ui.sendProgress.value = totalBytes > 0 ? Math.round((state.ble.progressBytes / totalBytes) * 100) : 0;
  }

  if (ui.chunkMeta) {
    if (state.render.envelope) {
      ui.chunkMeta.textContent =
        `BLE payload target ${MAX_ATT_PAYLOAD} B, ${state.render.rowsPerChunk} rows / chunk, ` +
        `${state.render.chunkPayloadBytes} bitmap bytes per chunk, ${state.render.chunkCount} data packets total.`;
    } else {
      ui.chunkMeta.textContent =
        `BLE payload target ${MAX_ATT_PAYLOAD} B. Prepare an image to calculate rows per chunk.`;
    }
  }

  if (!state.ble.supported) {
    setBleStatus("Web Bluetooth is not available in this browser.");
  } else if (state.ble.connected) {
    setBleStatus(`Connected to ${state.ble.device?.name || "printer"}.`);
  } else {
    setBleStatus("Bluetooth not connected.");
  }
}

function clearPendingAck(error) {
  if (!state.ble.pendingAck) {
    return;
  }

  clearTimeout(state.ble.pendingAck.timeoutId);
  const { reject } = state.ble.pendingAck;
  state.ble.pendingAck = null;
  reject(error);
}

function handleGattDisconnected() {
  clearPendingAck(new Error("Printer disconnected."));
  state.ble.device = null;
  state.ble.writeCharacteristic = null;
  state.ble.notifyCharacteristic = null;
  state.ble.connected = false;
  state.ble.busy = false;
  state.ble.progressBytes = 0;
  state.ble.progressChunks = 0;
  state.ble.transferId = 0;
  setSendStatus("Printer disconnected.");
  updateTransportUI();
}

async function disconnectBle() {
  if (state.ble.device?.gatt?.connected) {
    state.ble.device.gatt.disconnect();
  }

  handleGattDisconnected();
}

async function connectBle() {
  if (!state.ble.supported) {
    throw new Error("Web Bluetooth is unavailable in this browser.");
  }

  if (state.ble.connected) {
    return;
  }

  const device = await navigator.bluetooth.requestDevice({
    filters: [{ services: [BLE_CONFIG.serviceUuid] }]
  });

  device.addEventListener("gattserverdisconnected", handleGattDisconnected);

  const server = await device.gatt.connect();
  const service = await server.getPrimaryService(BLE_CONFIG.serviceUuid);
  const writeCharacteristic = await service.getCharacteristic(BLE_CONFIG.writeCharacteristicUuid);
  const notifyCharacteristic = await service.getCharacteristic(BLE_CONFIG.notifyCharacteristicUuid);

  notifyCharacteristic.addEventListener("characteristicvaluechanged", handleBleNotification);
  await notifyCharacteristic.startNotifications();

  state.ble.device = device;
  state.ble.writeCharacteristic = writeCharacteristic;
  state.ble.notifyCharacteristic = notifyCharacteristic;
  state.ble.connected = true;
  state.ble.progressBytes = 0;
  state.ble.progressChunks = 0;
  setSendStatus("Ready to send the prepared bitmap.");
  updateTransportUI();
}

function waitForAck(expectedType, transferId, sequence) {
  if (state.ble.pendingAck) {
    throw new Error("A BLE packet is already awaiting acknowledgement.");
  }

  return new Promise((resolve, reject) => {
    const timeoutId = window.setTimeout(() => {
      state.ble.pendingAck = null;
      reject(new Error(`Timed out waiting for ${packetTypeName(expectedType)} acknowledgement.`));
    }, ACK_TIMEOUT_MS);

    state.ble.pendingAck = {
      expectedType,
      transferId,
      sequence,
      resolve,
      reject,
      timeoutId
    };
  });
}

async function sendPacketAwaitAck(type, transferId, sequence, payload = new Uint8Array()) {
  if (!state.ble.writeCharacteristic) {
    throw new Error("Printer write characteristic is unavailable.");
  }

  const packet = encodePacket(type, transferId, sequence, payload);
  const ackPromise = waitForAck(type, transferId, sequence);

  try {
    await state.ble.writeCharacteristic.writeValue(packet);
    return await ackPromise;
  } catch (error) {
    clearPendingAck(error instanceof Error ? error : new Error(String(error)));
    throw error;
  }
}

async function sendResetPacket(transferId, sequence) {
  if (!state.ble.writeCharacteristic || !state.ble.connected) {
    return;
  }

  try {
    await state.ble.writeCharacteristic.writeValue(
      encodePacket(PACKET_TYPE.RESET, transferId, sequence)
    );
  } catch (error) {
    console.warn("Unable to send reset packet.", error);
  }
}

function handleBleNotification(event) {
  const dataView = event.target?.value;

  if (!dataView) {
    return;
  }

  const packet = new Uint8Array(dataView.buffer, dataView.byteOffset, dataView.byteLength).slice();
  const header = parsePacketHeader(packet);

  if (!header || packet.length !== PACKET_HEADER_SIZE + header.payloadLength) {
    return;
  }

  const pendingAck = state.ble.pendingAck;
  if (!pendingAck) {
    return;
  }

  if (header.transferId !== pendingAck.transferId || header.sequence !== pendingAck.sequence) {
    return;
  }

  clearTimeout(pendingAck.timeoutId);
  state.ble.pendingAck = null;

  try {
    if (header.type === PACKET_TYPE.ACK) {
      const ack = parseAckPacket(packet, header);

      if (ack.packetType !== pendingAck.expectedType) {
        throw new Error(
          `Expected ACK for ${packetTypeName(pendingAck.expectedType)}, received ${packetTypeName(ack.packetType)}.`
        );
      }

      pendingAck.resolve(ack);
      return;
    }

    if (header.type === PACKET_TYPE.ERROR) {
      const errorPacket = parseErrorPacket(packet, header);
      pendingAck.reject(
        new Error(
          `Printer rejected ${packetTypeName(errorPacket.packetType)}: ${protocolErrorName(errorPacket.error)} ` +
            `(expected sequence ${errorPacket.expectedSequence}, bytes received ${errorPacket.bytesReceived}).`
        )
      );
      return;
    }

    throw new Error(`Unexpected notification packet type ${packetTypeName(header.type)}.`);
  } catch (error) {
    pendingAck.reject(error instanceof Error ? error : new Error(String(error)));
  }
}

function createTransferId() {
  if (globalThis.crypto?.getRandomValues) {
    const values = new Uint32Array(1);
    globalThis.crypto.getRandomValues(values);
    return values[0] >>> 0;
  }

  return (Date.now() & 0xffffffff) >>> 0;
}

async function sendPreparedBitmap() {
  if (!state.ble.connected) {
    throw new Error("Connect to the printer before sending.");
  }

  if (!state.render.packedBitmap || !state.render.envelope) {
    throw new Error("Prepare an image before sending.");
  }

  const { envelope, packedBitmap, chunkPayloadBytes, chunkCount } = state.render;
  const transferId = createTransferId();

  state.ble.busy = true;
  state.ble.transferId = transferId;
  state.ble.progressBytes = 0;
  state.ble.progressChunks = 0;
  updateTransportUI();
  setSendStatus(`Starting transfer ${transferId}...`);

  try {
    await sendPacketAwaitAck(
      PACKET_TYPE.TRANSFER_START,
      transferId,
      0,
      encodeEnvelopePayload(envelope)
    );

    let sequence = 1;
    let offset = 0;

    while (offset < packedBitmap.length) {
      const nextOffset = Math.min(offset + chunkPayloadBytes, packedBitmap.length);
      const chunk = packedBitmap.slice(offset, nextOffset);
      const ack = await sendPacketAwaitAck(PACKET_TYPE.DATA_CHUNK, transferId, sequence, chunk);
      offset = nextOffset;
      sequence += 1;
      state.ble.progressBytes = ack.bytesReceived;
      state.ble.progressChunks = sequence - 1;
      setSendStatus(`Sent ${state.ble.progressChunks} / ${chunkCount} data packets.`);
      updateTransportUI();
    }

    await sendPacketAwaitAck(PACKET_TYPE.TRANSFER_COMMIT, transferId, sequence);
    state.ble.progressBytes = packedBitmap.length;
    state.ble.progressChunks = chunkCount;
    setSendStatus(`Transfer complete. ${packedBitmap.length} bytes sent in ${chunkCount} data packets.`);
  } catch (error) {
    const resetSequence = state.ble.progressChunks;
    await sendResetPacket(transferId, resetSequence);
    const message = error instanceof Error ? error.message : String(error);
    setSendStatus(`Transfer failed: ${message}`);
    throw error;
  } finally {
    state.ble.busy = false;
    updateTransportUI();
  }
}

function renderApp(root) {
  root.innerHTML = `
    <main class="layout">
      <section class="card source-card">
        <div class="source-row">
          <label class="file-label">
            <input id="file-input" type="file" accept="image/*" />
          </label>
          <button id="paste-btn" type="button">Paste</button>
        </div>
        <p id="status" class="status">Choose an image or paste one to begin.</p>
      </section>

      <section class="card settings-card">
        <div class="settings-grid">
          <label>
            Output width
            <input id="width-input" type="number" min="1" max="${MAX_WIDTH}" value="${MAX_WIDTH}" />
          </label>
          <label>
            Algorithm
            <select id="algorithm-input">
              <option value="atkinson" selected>Atkinson</option>
              <option value="floyd-steinberg">Floyd-Steinberg</option>
              <option value="ordered">Ordered Bayer</option>
              <option value="threshold">Threshold</option>
            </select>
          </label>
          <label>
            Background
            <input id="bg-color-input" type="color" value="#ffffff" />
          </label>
        </div>
        <div class="sliders">
          <div class="slider-row">
            <label for="brightness-input"><span>Brightness</span><span id="brightness-display">0</span></label>
            <input id="brightness-input" type="range" min="-100" max="100" value="0" step="1" />
          </div>
          <div class="slider-row">
            <label for="contrast-input"><span>Contrast</span><span id="contrast-display">0</span></label>
            <input id="contrast-input" type="range" min="-100" max="100" value="0" step="1" />
          </div>
          <div class="slider-row" id="threshold-row">
            <label for="threshold-input"><span>Threshold</span><span id="threshold-display">128</span></label>
            <input id="threshold-input" type="range" min="0" max="255" value="128" step="1" />
          </div>
        </div>
      </section>

      <article class="card preview-card">
        <div class="canvas-frame">
          <canvas id="output-canvas"></canvas>
        </div>
        <button id="copy-btn" type="button">Copy to clipboard</button>
      </article>

      <section class="card ble-card">
        <h2>Bluetooth transport</h2>
        <div class="button-row">
          <button id="connect-btn" class="primary" type="button">Connect printer</button>
          <button id="disconnect-btn" class="secondary" type="button">Disconnect</button>
          <button id="send-btn" class="primary" type="button">Send to printer</button>
        </div>
        <p id="ble-status" class="status">Bluetooth not connected.</p>
        <p id="send-status" class="meta">Prepare an image, then connect to the printer.</p>
        <progress id="send-progress" max="100" value="0"></progress>
      </section>

      <details class="card details-card">
        <summary>Details</summary>
        <dl id="job-summary" class="detail-list"></dl>
        <p id="chunk-meta" class="meta"></p>
        <p class="meta">Service UUID <code>${BLE_CONFIG.serviceUuid}</code></p>
        <p class="meta">Write characteristic <code>${BLE_CONFIG.writeCharacteristicUuid}</code></p>
        <p class="meta">Notify characteristic <code>${BLE_CONFIG.notifyCharacteristicUuid}</code></p>
      </details>
    </main>
  `;

  const fileInput = root.querySelector("#file-input");
  const pasteBtn = root.querySelector("#paste-btn");
  const widthInput = root.querySelector("#width-input");
  const algorithmInput = root.querySelector("#algorithm-input");
  const bgColorInput = root.querySelector("#bg-color-input");
  const brightnessInput = root.querySelector("#brightness-input");
  const brightnessDisplay = root.querySelector("#brightness-display");
  const contrastInput = root.querySelector("#contrast-input");
  const contrastDisplay = root.querySelector("#contrast-display");
  const thresholdRow = root.querySelector("#threshold-row");
  const thresholdInput = root.querySelector("#threshold-input");
  const thresholdDisplay = root.querySelector("#threshold-display");
  const status = root.querySelector("#status");
  const summary = root.querySelector("#job-summary");
  const outputCanvas = root.querySelector("#output-canvas");
  const copyBtn = root.querySelector("#copy-btn");
  const connectBtn = root.querySelector("#connect-btn");
  const disconnectBtn = root.querySelector("#disconnect-btn");
  const sendBtn = root.querySelector("#send-btn");
  const bleStatus = root.querySelector("#ble-status");
  const sendStatus = root.querySelector("#send-status");
  const sendProgress = root.querySelector("#send-progress");
  const chunkMeta = root.querySelector("#chunk-meta");

  // Hidden off-screen textarea used as a reliable paste-event sink on mobile
  // browsers (Bluefy, Edge) where document-level paste events only fire when
  // a focusable element is active.
  const pasteTarget = document.createElement("textarea");
  pasteTarget.id = "paste-target";
  pasteTarget.setAttribute("aria-label", "Paste image here");
  pasteTarget.setAttribute("tabindex", "-1");
  document.body.appendChild(pasteTarget);

  const sourceCanvas = document.createElement("canvas");

  if (
    !fileInput ||
    !pasteBtn ||
    !widthInput ||
    !algorithmInput ||
    !bgColorInput ||
    !brightnessInput ||
    !brightnessDisplay ||
    !contrastInput ||
    !contrastDisplay ||
    !thresholdRow ||
    !thresholdInput ||
    !thresholdDisplay ||
    !status ||
    !summary ||
    !outputCanvas ||
    !copyBtn ||
    !connectBtn ||
    !disconnectBtn ||
    !sendBtn ||
    !bleStatus ||
    !sendStatus ||
    !sendProgress ||
    !chunkMeta
  ) {
    throw new Error("Image pipeline UI failed to initialize");
  }

  Object.assign(ui, {
    fileInput,
    pasteBtn,
    widthInput,
    algorithmInput,
    bgColorInput,
    brightnessInput,
    brightnessDisplay,
    contrastInput,
    contrastDisplay,
    thresholdRow,
    thresholdInput,
    thresholdDisplay,
    status,
    summary,
    sourceCanvas,
    outputCanvas,
    copyBtn,
    connectBtn,
    disconnectBtn,
    sendBtn,
    bleStatus,
    sendStatus,
    sendProgress,
    chunkMeta,
    pasteTarget
  });

  function updateSliderDisplays() {
    ui.brightnessDisplay.textContent = ui.brightnessInput.value;
    ui.contrastDisplay.textContent = ui.contrastInput.value;
    ui.thresholdDisplay.textContent = ui.thresholdInput.value;
  }

  function updateThresholdVisibility() {
    ui.thresholdRow.style.display = ui.algorithmInput.value === "threshold" ? "" : "none";
  }

  function renderJob() {
    updateSliderDisplays();
    updateThresholdVisibility();

    if (!state.image) {
      state.render.envelope = null;
      state.render.packedBitmap = null;
      state.render.rowsPerChunk = 0;
      state.render.chunkPayloadBytes = 0;
      state.render.chunkCount = 0;
      state.ble.progressBytes = 0;
      state.ble.progressChunks = 0;
      ui.summary.innerHTML = "";
      updateTransportUI();
      return;
    }

    const requestedWidth = clampDimension(Number(ui.widthInput.value));
    const { width, height } = calculateTargetSize(
      state.sourceWidth,
      state.sourceHeight,
      requestedWidth
    );

    ui.widthInput.value = String(width);

    const bgColor = ui.bgColorInput.value;
    drawSourceToCanvas(state.image, ui.sourceCanvas, width, height, bgColor);
    const sourceContext = ui.sourceCanvas.getContext("2d");

    if (!sourceContext) {
      throw new Error("Missing source canvas context");
    }

    const imageData = sourceContext.getImageData(0, 0, width, height);
    const rawGrayscale = toGrayscale(imageData);
    const brightness = Number(ui.brightnessInput.value);
    const contrast = Number(ui.contrastInput.value);
    const grayscale = applyBrightnessContrast(rawGrayscale, brightness, contrast);
    const algorithm = ui.algorithmInput.value;
    const threshold = Number(ui.thresholdInput.value);
    const dithered = ditherImage(grayscale, width, height, algorithm, threshold);

    renderBinaryPreview(ui.outputCanvas, width, height, dithered);

    const packedBitmap = packMonochrome(dithered, width, height);
    const envelope = buildEnvelope(width, height);
    const chunkPlan = buildChunkPlan(envelope);

    state.render.envelope = envelope;
    state.render.packedBitmap = packedBitmap;
    state.render.rowsPerChunk = chunkPlan.rowsPerChunk;
    state.render.chunkPayloadBytes = chunkPlan.chunkPayloadBytes;
    state.render.chunkCount = chunkPlan.chunkCount;
    state.render.algorithm = algorithm;
    state.ble.progressBytes = 0;
    state.ble.progressChunks = 0;

    setImageStatus(`Ready — ${state.fileName}, ${width} × ${height} px, ${algorithm}.`);
    ui.summary.innerHTML = `
      <div><dt>Source</dt><dd>${state.sourceWidth} × ${state.sourceHeight}</dd></div>
      <div><dt>Output</dt><dd>${width} × ${height}</dd></div>
      <div><dt>Stride</dt><dd>${envelope.strideBytes} B/row</dd></div>
      <div><dt>Payload</dt><dd>${packedBitmap.length} B</dd></div>
      <div><dt>Rows / chunk</dt><dd>${chunkPlan.rowsPerChunk}</dd></div>
      <div><dt>BLE packets</dt><dd>${chunkPlan.chunkCount}</dd></div>
    `;

    updateTransportUI();
  }

  function applyImageSource(image, name) {
    state.image = image;
    state.fileName = name;
    state.sourceWidth = image.naturalWidth || image.width;
    state.sourceHeight = image.naturalHeight || image.height;
    renderJob();
  }

  fileInput.addEventListener("change", async () => {
    const [file] = fileInput.files ?? [];

    if (!file) {
      return;
    }

    setImageStatus(`Loading ${file.name}…`);

    try {
      const image = await loadImageFromFile(file);
      applyImageSource(image, file.name);
    } catch (error) {
      console.error(error);
      setImageStatus("Unable to load the selected image.");
    }
  });

  // Shared handler for paste events received via clipboardData (document or
  // the pasteTarget textarea).  Returns true when an image was found so the
  // caller can call preventDefault.
  const handleImagePaste = async (clipboardData) => {
    const items = [...(clipboardData?.items ?? [])];
    const imageItem = items.find(item => item.type.startsWith("image/"));

    if (!imageItem) {
      return false;
    }

    const file = imageItem.getAsFile();

    if (!file) {
      return false;
    }

    setImageStatus("Loading pasted image…");

    try {
      const image = await loadImageFromFile(file);
      applyImageSource(image, "clipboard");
    } catch (error) {
      console.error(error);
      setImageStatus("Unable to load the pasted image.");
    }

    return true;
  };

  pasteBtn.addEventListener("click", async () => {
    setImageStatus("Reading clipboard…");

    try {
      const items = await navigator.clipboard.read();
      const imageItem = items.find(item => item.types.some(type => type.startsWith("image/")));

      if (!imageItem) {
        setImageStatus("No image found in clipboard.");
        return;
      }

      const imageType = imageItem.types.find(type => type.startsWith("image/"));
      const blob = await imageItem.getType(imageType);
      const image = await loadImageFromFile(new File([blob], "clipboard", { type: imageType }));
      applyImageSource(image, "clipboard");
    } catch (error) {
      console.error(error);
      // clipboard.read() is blocked on most mobile browsers.  Focus the
      // off-screen textarea so the OS paste gesture delivers its paste event
      // to a concrete element, which works more reliably than relying on the
      // document-level paste event in Bluefy / Edge / Safari.
      pasteTarget.focus();
      setImageStatus("Paste an image using your device’s paste gesture or Ctrl+V / Cmd+V.");
    }
  });

  document.addEventListener("paste", async (event) => {
    const handled = await handleImagePaste(event.clipboardData);
    if (handled) {
      event.preventDefault();
    }
  });

  // Also listen on the textarea so that paste events from a focused element
  // are captured in browsers (Bluefy, Edge) that do not reliably fire the
  // document-level paste event without an active focusable element.
  pasteTarget.addEventListener("paste", async (event) => {
    event.preventDefault();
    await handleImagePaste(event.clipboardData);
  });

  // Safari requires the Promise to be passed directly to ClipboardItem rather
  // than resolving it first.  If the blob is awaited before constructing
  // ClipboardItem the call falls outside the synchronous user-gesture frame
  // and Safari refuses to write to the clipboard.
  const copyOutputToClipboard = async () => {
    if (!state.image) {
      return;
    }

    try {
      const blobPromise = new Promise((resolve, reject) =>
        outputCanvas.toBlob(
          (b) => (b ? resolve(b) : reject(new Error("Canvas toBlob returned null."))),
          "image/png"
        )
      );

      await navigator.clipboard.write([new ClipboardItem({ "image/png": blobPromise })]);
      setImageStatus("Output copied to clipboard.");
    } catch (error) {
      console.error(error);
      setImageStatus("Unable to copy output to clipboard.");
    }
  }

  ui.outputCanvas.addEventListener("click", copyOutputToClipboard);
  ui.copyBtn.addEventListener("click", copyOutputToClipboard);

  ui.connectBtn.addEventListener("click", async () => {
    setSendStatus("Connecting to printer...");

    try {
      await connectBle();
    } catch (error) {
      console.error(error);
      setSendStatus(error instanceof Error ? error.message : String(error));
    }
  });

  ui.disconnectBtn.addEventListener("click", async () => {
    await disconnectBle();
  });

  ui.sendBtn.addEventListener("click", async () => {
    try {
      await sendPreparedBitmap();
    } catch (error) {
      console.error(error);
    }
  });

  ui.widthInput.addEventListener("input", renderJob);
  ui.algorithmInput.addEventListener("input", renderJob);
  ui.bgColorInput.addEventListener("input", renderJob);
  ui.brightnessInput.addEventListener("input", renderJob);
  ui.contrastInput.addEventListener("input", renderJob);
  ui.thresholdInput.addEventListener("input", renderJob);

  updateSliderDisplays();
  updateThresholdVisibility();
  updateTransportUI();
}

const root = document.querySelector("#app");

if (!root) {
  throw new Error("Missing #app root element");
}

renderApp(root);

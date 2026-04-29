const MAX_WIDTH = 384;
const DEFAULT_CANVAS_SIZE = 384;
const MAX_HEIGHT_PERCENT = 100;
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
  ERROR: 0x06,
  CONFIGURE: 0x07,
  FEED: 0x08
};
const PACKET_TYPE_NAME = new Map([
  [PACKET_TYPE.TRANSFER_START, "transfer-start"],
  [PACKET_TYPE.DATA_CHUNK, "data-chunk"],
  [PACKET_TYPE.TRANSFER_COMMIT, "transfer-commit"],
  [PACKET_TYPE.RESET, "reset"],
  [PACKET_TYPE.ACK, "ack"],
  [PACKET_TYPE.ERROR, "error"],
  [PACKET_TYPE.CONFIGURE, "configure"],
  [PACKET_TYPE.FEED, "feed"]
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
const PRINTER_CONFIG_SIZE = 10;

const PAPER_PRESETS = {
  normal: {
    label: "Normal paper",
    heatDots: 5,
    heatTime: 120,
    heatInterval: 10,
    density: 0,
    breakTime: 0,
    printSpeed: 0,
    feedSpeed: 0,
    preFeedRows: 0
  },
  sticker: {
    label: "Sticker paper",
    heatDots: 2,
    heatTime: 140,
    heatInterval: 15,
    density: 0,
    breakTime: 0,
    printSpeed: 0,
    feedSpeed: 0,
    preFeedRows: 2
  },
};

const state = {
  fileName: "blank canvas",
  image: null,
  sourceWidth: DEFAULT_CANVAS_SIZE,
  sourceHeight: DEFAULT_CANVAS_SIZE,
  rotation: 0,
  invert: false,
  textBlocks: [],
  nextTextBlockId: 1,
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

function clampHeightPercent(value) {
  if (!Number.isFinite(value)) {
    return MAX_HEIGHT_PERCENT;
  }

  return Math.max(1, Math.min(MAX_HEIGHT_PERCENT, Math.round(value)));
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

function calculateTargetSize(sourceWidth, sourceHeight, requestedWidth, requestedHeightPercent) {
  const contentWidth = clampDimension(requestedWidth);
  const contentHeight = Math.max(1, Math.round((sourceHeight * contentWidth) / sourceWidth));
  const heightPercent = clampHeightPercent(requestedHeightPercent);
  const canvasHeight = Math.max(1, Math.round((contentHeight * heightPercent) / 100));

  return {
    contentWidth,
    contentHeight,
    canvasWidth: MAX_WIDTH,
    canvasHeight,
    heightPercent
  };
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

function drawSourceToCanvas(image, canvas, width, height, contentWidth, contentHeight, bgColor, rotation) {
  const context = canvas.getContext("2d");

  if (!context) {
    throw new Error("2D canvas context is unavailable.");
  }

  canvas.width = width;
  canvas.height = height;
  context.imageSmoothingEnabled = true;
  context.fillStyle = bgColor;
  context.fillRect(0, 0, width, height);

  if (!image) {
    return;
  }

  if (rotation) {
    context.save();
    context.translate(width / 2, height / 2);
    context.rotate((rotation * Math.PI) / 180);
    const swapped = rotation === 90 || rotation === 270;
    const dw = swapped ? contentHeight : contentWidth;
    const dh = swapped ? contentWidth : contentHeight;
    context.drawImage(image, -dw / 2, -dh / 2, dw, dh);
    context.restore();
  } else {
    context.drawImage(image, (width - contentWidth) / 2, (height - contentHeight) / 2, contentWidth, contentHeight);
  }
}

function drawTextBlocks(canvas, textBlocks, layout) {
  if (!textBlocks.length) return;

  const context = canvas.getContext("2d");
  if (!context) return;

  const {
    originX = 0,
    originY = 0,
    width = canvas.width,
    height = canvas.height,
    scale = 1
  } = layout ?? {};

  for (const block of textBlocks) {
    if (!block.text) continue;

    const fontSize = Math.max(1, Math.round((block.fontSize || 32) * scale));
    context.font = `bold ${fontSize}px ${block.font || "Impact"}`;
    context.textBaseline = "top";

    const x = originX + ((block.xPct ?? 0) / 100) * width;
    const y = originY + ((block.yPct ?? 0) / 100) * height;
    const outlineWidth = block.outlineWidth > 0
      ? Math.max(1, (block.outlineWidth || 0) * scale)
      : 0;

    if (outlineWidth > 0) {
      context.strokeStyle = block.outlineColor || "#ffffff";
      context.lineWidth = outlineWidth;
      context.lineJoin = "round";
      context.strokeText(block.text, x, y);
    }

    context.fillStyle = block.color || "#000000";
    context.fillText(block.text, x, y);
  }
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

function invertGrayscale(grayscale) {
  const inverted = new Float32Array(grayscale.length);

  for (let index = 0; index < grayscale.length; index += 1) {
    inverted[index] = 255 - grayscale[index];
  }

  return inverted;
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
  if (ui.bleStatus) {
    ui.bleStatus.textContent = message;
  }
}

function updateTransportUI() {
  if (!ui.connectBtn) {
    return;
  }

  const hasBitmap = Boolean(state.render.packedBitmap && state.render.envelope);
  ui.connectBtn.disabled = !state.ble.supported || state.ble.busy;
  ui.connectBtn.textContent = state.ble.connected ? "Disconnect" : "Connect printer";
  ui.connectBtn.className = state.ble.connected ? "secondary" : "primary";
  ui.sendBtn.disabled = !state.ble.supported || !hasBitmap || state.ble.busy;

  if (ui.feedBtn) {
    ui.feedBtn.disabled = !state.ble.supported || state.ble.busy;
  }

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
  await sendResetPacket(0, 0);
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

async function sendPrinterConfig(preset) {
  if (!state.ble.writeCharacteristic || !state.ble.connected) {
    return;
  }

  const config = PAPER_PRESETS[preset];
  if (!config) {
    return;
  }

  const payload = new Uint8Array(PRINTER_CONFIG_SIZE);
  payload[0] = config.heatDots;
  payload[1] = config.heatTime;
  payload[2] = config.heatInterval;
  payload[3] = config.density;
  payload[4] = config.breakTime;
  writeUint16Le(payload, 5, config.printSpeed);
  writeUint16Le(payload, 7, config.feedSpeed);
  payload[9] = config.preFeedRows;

  await sendPacketAwaitAck(PACKET_TYPE.CONFIGURE, 0, 0, payload);
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

async function sendFeedRow(lines = 1) {
  if (!state.ble.connected) {
    setSendStatus("Connecting to printer...");
    try {
      await connectBle();
    } catch {
      updateTransportUI();
      return;
    }
  }

  state.ble.busy = true;
  updateTransportUI();
  setSendStatus("Feeding paper...");

  try {
    const payload = new Uint8Array([lines]);
    await sendPacketAwaitAck(PACKET_TYPE.FEED, 0, 0, payload);
    setSendStatus("Feed complete.");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setSendStatus(`Feed failed: ${message}`);
    throw error;
  } finally {
    state.ble.busy = false;
    updateTransportUI();
  }
}

async function sendPreparedBitmap() {
  if (!state.ble.connected) {
    setSendStatus("Connecting to printer...");
    try {
      await connectBle();
    } catch {
      updateTransportUI();
      return;
    }
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

  const paperType = ui.paperTypeInput?.value || "normal";
  await sendPrinterConfig(paperType);
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
        <p id="status" class="status">Ready with a blank 384 × 384 canvas. Add text or load an image.</p>
      </section>

      <section class="card settings-card">
        <div class="settings-row">
          <select id="algorithm-input">
            <option value="atkinson" selected>Atkinson</option>
            <option value="floyd-steinberg">Floyd-Steinberg</option>
            <option value="ordered">Ordered Bayer</option>
            <option value="threshold">Threshold</option>
          </select>
          <input id="bg-color-input" type="color" value="#ffffff" title="Background color" />
          <button id="rotate-btn" type="button" title="Rotate 90\u00B0">🔄</button>
          <button id="invert-btn" type="button" title="Invert image">🔀</button>
          <button id="add-text-btn" type="button" title="Add text">🔤</button>
        </div>
        <div class="size-controls">
          <label class="slider-control" for="width-input">
            <span>Width <output id="width-output">${MAX_WIDTH}px</output></span>
            <input id="width-input" type="range" min="1" max="${MAX_WIDTH}" value="${MAX_WIDTH}" step="1" />
          </label>
          <label class="slider-control" for="height-input">
            <span>Height <output id="height-output">100%</output></span>
            <input id="height-input" type="range" min="1" max="${MAX_HEIGHT_PERCENT}" value="${MAX_HEIGHT_PERCENT}" step="1" />
          </label>
        </div>
        <div id="text-blocks-container"></div>
        <div class="sliders">
          <div class="slider-row">
            <label for="brightness-input">Brightness</label>
            <input id="brightness-input" type="range" min="-100" max="100" value="0" step="1" />
          </div>
          <div class="slider-row">
            <label for="contrast-input">Contrast</label>
            <input id="contrast-input" type="range" min="-100" max="100" value="0" step="1" />
          </div>
          <div class="slider-row" id="threshold-row" style="display:none">
            <label for="threshold-input">Threshold</label>
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
        <div class="button-row">
          <button id="connect-btn" class="primary" type="button">Connect printer</button>
          <button id="send-btn" class="primary" type="button">Print</button>
        </div>
        <progress id="send-progress" max="100" value="0"></progress>
        <p id="ble-status" class="status">Bluetooth not connected.</p>
        <div class="settings-row" style="margin-top: 0.5rem">
          <label for="paper-type-input" style="align-self:center;font-size:0.875rem;color:#c9d2e3;white-space:nowrap">Paper</label>
          <select id="paper-type-input">
            <option value="normal" selected>Normal paper</option>
            <option value="sticker">Sticker paper</option>
          </select>
          <button id="feed-btn" type="button" title="Feed paper">⏏</button>
        </div>
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
  const rotateBtn = root.querySelector("#rotate-btn");
  const invertBtn = root.querySelector("#invert-btn");
  const widthInput = root.querySelector("#width-input");
  const widthOutput = root.querySelector("#width-output");
  const heightInput = root.querySelector("#height-input");
  const heightOutput = root.querySelector("#height-output");
  const algorithmInput = root.querySelector("#algorithm-input");
  const bgColorInput = root.querySelector("#bg-color-input");
  const brightnessInput = root.querySelector("#brightness-input");
  const contrastInput = root.querySelector("#contrast-input");
  const thresholdRow = root.querySelector("#threshold-row");
  const thresholdInput = root.querySelector("#threshold-input");
  const status = root.querySelector("#status");
  const summary = root.querySelector("#job-summary");
  const outputCanvas = root.querySelector("#output-canvas");
  const copyBtn = root.querySelector("#copy-btn");
  const connectBtn = root.querySelector("#connect-btn");
  const sendBtn = root.querySelector("#send-btn");
  const bleStatus = root.querySelector("#ble-status");
  const sendProgress = root.querySelector("#send-progress");
  const paperTypeInput = root.querySelector("#paper-type-input");
  const chunkMeta = root.querySelector("#chunk-meta");
  const feedBtn = root.querySelector("#feed-btn");
  const addTextBtn = root.querySelector("#add-text-btn");
  const textBlocksContainer = root.querySelector("#text-blocks-container");

  // Hidden off-screen contenteditable div used as a reliable paste-event sink
  // on mobile browsers (Bluefy, Edge, iOS Safari) where document-level paste
  // events only fire when a focusable element is active.  A contenteditable
  // element is required on iOS: pasting into a <textarea> causes iOS to omit
  // image data from event.clipboardData, whereas a contenteditable div receives
  // the full image clipboard item.
  const pasteTarget = document.createElement("div");
  pasteTarget.id = "paste-target";
  pasteTarget.setAttribute("contenteditable", "true");
  pasteTarget.setAttribute("aria-label", "Paste image here");
  pasteTarget.setAttribute("tabindex", "-1");
  document.body.appendChild(pasteTarget);

  const sourceCanvas = document.createElement("canvas");

  if (
    !fileInput ||
    !pasteBtn ||
    !rotateBtn ||
    !invertBtn ||
    !widthInput ||
    !widthOutput ||
    !heightInput ||
    !heightOutput ||
    !algorithmInput ||
    !bgColorInput ||
    !brightnessInput ||
    !contrastInput ||
    !thresholdRow ||
    !thresholdInput ||
    !status ||
    !summary ||
    !outputCanvas ||
    !copyBtn ||
    !connectBtn ||
    !sendBtn ||
    !bleStatus ||
    !sendProgress ||
    !paperTypeInput ||
    !chunkMeta ||
    !feedBtn ||
    !addTextBtn ||
    !textBlocksContainer
  ) {
    throw new Error("Image pipeline UI failed to initialize");
  }

  Object.assign(ui, {
    fileInput,
    pasteBtn,
    rotateBtn,
    invertBtn,
    widthInput,
    widthOutput,
    heightInput,
    heightOutput,
    algorithmInput,
    bgColorInput,
    brightnessInput,
    contrastInput,
    thresholdRow,
    thresholdInput,
    status,
    summary,
    sourceCanvas,
    outputCanvas,
    copyBtn,
    connectBtn,
    sendBtn,
    bleStatus,
    sendProgress,
    paperTypeInput,
    chunkMeta,
    feedBtn,
    addTextBtn,
    textBlocksContainer,
    pasteTarget
  });

  function updateThresholdVisibility() {
    ui.thresholdRow.style.display = ui.algorithmInput.value === "threshold" ? "flex" : "none";
  }

  function updateInvertButton() {
    ui.invertBtn.classList.toggle("active", state.invert);
    ui.invertBtn.setAttribute("aria-pressed", state.invert ? "true" : "false");
  }

  function updateSizeOutputs(contentWidth, heightPercent, canvasHeight) {
    ui.widthOutput.value = `${contentWidth}px`;
    ui.widthOutput.textContent = `${contentWidth}px`;
    ui.heightOutput.value = `${heightPercent}%`;
    ui.heightOutput.textContent = `${heightPercent}% · ${canvasHeight}px`;
  }

  function renderTextBlocksUI() {
    ui.textBlocksContainer.innerHTML = "";
    for (const block of state.textBlocks) {
      const entry = document.createElement("div");
      entry.className = "text-block-entry";
      entry.innerHTML = `
        <div class="text-block-row">
          <input type="text" class="tb-text" placeholder="Enter text" value="${(block.text || "").replace(/"/g, "&quot;")}" />
          <button type="button" class="tb-delete" title="Remove">✕</button>
        </div>
        <div class="text-block-row">
          <select class="tb-font">
            <option value="Impact"${block.font === "Impact" ? " selected" : ""}>Impact</option>
            <option value="Arial Black"${block.font === "Arial Black" ? " selected" : ""}>Arial Black</option>
            <option value="Georgia"${block.font === "Georgia" ? " selected" : ""}>Georgia</option>
            <option value="Courier New"${block.font === "Courier New" ? " selected" : ""}>Courier New</option>
          </select>
          <input type="number" class="tb-fontsize" value="${block.fontSize || 32}" min="8" max="200" step="1" title="Font size" />
          <input type="color" class="tb-color" value="${block.color || "#000000"}" title="Text color" />
          <input type="color" class="tb-outline-color" value="${block.outlineColor || "#ffffff"}" title="Outline color" />
          <input type="number" class="tb-outline-width" value="${block.outlineWidth ?? 2}" min="0" max="20" step="1" title="Outline width" />
        </div>
        <div class="text-block-row">
          <label>X</label>
          <input type="range" class="tb-x" value="${block.xPct ?? 0}" min="0" max="100" step="1" />
          <label>Y</label>
          <input type="range" class="tb-y" value="${block.yPct ?? 0}" min="0" max="100" step="1" />
        </div>
      `;

      const update = (field, value) => {
        block[field] = value;
        renderJob();
      };

      entry.querySelector(".tb-text").addEventListener("input", (e) => update("text", e.target.value));
      entry.querySelector(".tb-font").addEventListener("input", (e) => update("font", e.target.value));
      entry.querySelector(".tb-fontsize").addEventListener("input", (e) => update("fontSize", Number(e.target.value)));
      entry.querySelector(".tb-color").addEventListener("input", (e) => update("color", e.target.value));
      entry.querySelector(".tb-outline-color").addEventListener("input", (e) => update("outlineColor", e.target.value));
      entry.querySelector(".tb-outline-width").addEventListener("input", (e) => update("outlineWidth", Number(e.target.value)));
      entry.querySelector(".tb-x").addEventListener("input", (e) => update("xPct", Number(e.target.value)));
      entry.querySelector(".tb-y").addEventListener("input", (e) => update("yPct", Number(e.target.value)));
      entry.querySelector(".tb-delete").addEventListener("click", () => {
        state.textBlocks = state.textBlocks.filter((b) => b.id !== block.id);
        renderTextBlocksUI();
        renderJob();
      });

      ui.textBlocksContainer.appendChild(entry);
    }
  }

  function renderJob() {
    updateThresholdVisibility();
    updateInvertButton();

    const requestedWidth = clampDimension(Number(ui.widthInput.value));
    const requestedHeightPercent = clampHeightPercent(Number(ui.heightInput.value));
    const swapped = state.rotation === 90 || state.rotation === 270;
    const srcW = swapped ? state.sourceHeight : state.sourceWidth;
    const srcH = swapped ? state.sourceWidth : state.sourceHeight;
    const { contentWidth, contentHeight, canvasWidth, canvasHeight, heightPercent } = calculateTargetSize(
      srcW,
      srcH,
      requestedWidth,
      requestedHeightPercent
    );

    ui.widthInput.value = String(contentWidth);
    ui.heightInput.value = String(heightPercent);
    updateSizeOutputs(contentWidth, heightPercent, canvasHeight);

    const bgColor = ui.bgColorInput.value;
    const contentOriginX = (canvasWidth - contentWidth) / 2;
    const contentOriginY = (canvasHeight - contentHeight) / 2;
    drawSourceToCanvas(
      state.image,
      ui.sourceCanvas,
      canvasWidth,
      canvasHeight,
      contentWidth,
      contentHeight,
      bgColor,
      state.rotation
    );
    drawTextBlocks(ui.sourceCanvas, state.textBlocks, {
      originX: contentOriginX,
      originY: contentOriginY,
      width: contentWidth,
      height: contentHeight,
      scale: contentWidth / DEFAULT_CANVAS_SIZE
    });
    const sourceContext = ui.sourceCanvas.getContext("2d", { willReadFrequently: true });

    if (!sourceContext) {
      throw new Error("Missing source canvas context");
    }

    const imageData = sourceContext.getImageData(0, 0, canvasWidth, canvasHeight);
    const rawGrayscale = toGrayscale(imageData);
    const brightness = Number(ui.brightnessInput.value);
    const contrast = Number(ui.contrastInput.value);
    const adjustedGrayscale = applyBrightnessContrast(rawGrayscale, brightness, contrast);
    const grayscale = state.invert ? invertGrayscale(adjustedGrayscale) : adjustedGrayscale;
    const algorithm = ui.algorithmInput.value;
    const threshold = Number(ui.thresholdInput.value);
    const dithered = ditherImage(grayscale, canvasWidth, canvasHeight, algorithm, threshold);

    renderBinaryPreview(ui.outputCanvas, canvasWidth, canvasHeight, dithered);

    const packedBitmap = packMonochrome(dithered, canvasWidth, canvasHeight);
    const envelope = buildEnvelope(canvasWidth, canvasHeight);
    const chunkPlan = buildChunkPlan(envelope);

    state.render.envelope = envelope;
    state.render.packedBitmap = packedBitmap;
    state.render.rowsPerChunk = chunkPlan.rowsPerChunk;
    state.render.chunkPayloadBytes = chunkPlan.chunkPayloadBytes;
    state.render.chunkCount = chunkPlan.chunkCount;
    state.render.algorithm = algorithm;
    state.ble.progressBytes = 0;
    state.ble.progressChunks = 0;

    setImageStatus(
      `Ready — ${state.fileName}, content ${contentWidth} × ${contentHeight} px on a ${canvasWidth} × ${canvasHeight} canvas, ${algorithm}.`
    );
    ui.summary.innerHTML = `
      <div><dt>Source</dt><dd>${state.sourceWidth} × ${state.sourceHeight}</dd></div>
      <div><dt>Content</dt><dd>${contentWidth} × ${contentHeight}</dd></div>
      <div><dt>Canvas</dt><dd>${canvasWidth} × ${canvasHeight}</dd></div>
      <div><dt>Invert</dt><dd>${state.invert ? "On" : "Off"}</dd></div>
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
    state.rotation = 0;
    ui.heightInput.value = String(MAX_HEIGHT_PERCENT);
    state.textBlocks = [];
    state.nextTextBlockId = 1;
    renderTextBlocksUI();
    renderJob();
  }

  addTextBtn.addEventListener("click", () => {
    state.textBlocks.push({
      id: state.nextTextBlockId++,
      text: "",
      font: "Impact",
      fontSize: 72,
      color: "#ffffff",
      outlineColor: "#000000",
      outlineWidth: 10,
      xPct: 0,
      yPct: 0,
    });
    renderTextBlocksUI();
    renderJob();
  });

  rotateBtn.addEventListener("click", () => {
    state.rotation = (state.rotation + 90) % 360;
    renderJob();
  });

  invertBtn.addEventListener("click", () => {
    state.invert = !state.invert;
    renderJob();
  });

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

  // Synchronously extracts an image File from clipboardData, or returns null.
  // Must remain synchronous so callers can invoke event.preventDefault() before
  // yielding to the microtask queue.
  const findImageInClipboard = (clipboardData) => {
    const items = [...(clipboardData?.items ?? [])];
    const imageItem = items.find(item => item.type.startsWith("image/"));
    if (!imageItem) return null;
    return imageItem.getAsFile() || null;
  };

  // Async image loader called after the paste event has been synchronously
  // handled (preventDefault already called by the time this runs).
  const loadPastedImage = async (file) => {
    setImageStatus("Loading pasted image…");
    try {
      const image = await loadImageFromFile(file);
      applyImageSource(image, "clipboard");
    } catch (error) {
      console.error(error);
      setImageStatus("Unable to load the pasted image.");
    }
  };

  // Parses an HTML string and returns the src of the first <img> found, or null.
  const extractImageSrcFromHtml = (html) => {
    try {
      const doc = new DOMParser().parseFromString(html, "text/html");
      const img = doc.querySelector("img[src]");
      return img?.src ?? null;
    } catch {
      return null;
    }
  };

  // Returns the text/html DataTransferItem from a DataTransferItemList, or null.
  const findHtmlItemInClipboardData = (clipboardData) => {
    const items = [...(clipboardData?.items ?? [])];
    return items.find(item => item.type === "text/html") ?? null;
  };

  // Fetches an image from a URL (handles data: URIs and CORS URLs) and returns
  // a loaded HTMLImageElement.  Only http:, https:, and data: schemes are
  // permitted.  Throws if the scheme is disallowed, the fetch fails, or the
  // response is not an image.
  const loadImageFromUrl = async (url) => {
    const parsed = new URL(url, location.href);
    if (!["http:", "https:", "data:"].includes(parsed.protocol)) {
      throw new Error(`Unsupported URL scheme: ${parsed.protocol}`);
    }
    // data: URIs can be decoded directly via fetch without a network request.
    const response = await fetch(url, parsed.protocol === "data:" ? undefined : { mode: "cors" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const blob = await response.blob();
    if (!blob.type.startsWith("image/")) throw new Error("Response is not an image.");
    return loadImageFromFile(new File([blob], "pasted-image", { type: blob.type }));
  };

  // Extracts an image from a pasted HTML string (browser "Copy Image" path).
  // Expected to be called after event.preventDefault() has already been issued.
  const loadPastedImageFromHtml = async (html) => {
    const src = extractImageSrcFromHtml(html);
    if (!src) {
      setImageStatus("No image found in clipboard.");
      return;
    }
    setImageStatus("Loading pasted image…");
    try {
      const image = await loadImageFromUrl(src);
      applyImageSource(image, "clipboard");
    } catch (error) {
      console.error(error);
      setImageStatus("Unable to fetch the pasted image. Try saving it locally and using the file picker instead.");
    }
  };

  pasteBtn.addEventListener("click", async () => {
    setImageStatus("Reading clipboard…");

    try {
      const items = await navigator.clipboard.read();
      const imageItem = items.find(item => item.types.some(type => type.startsWith("image/")));

      if (!imageItem) {
        // clipboard.read() succeeded but returned no image type.  Browsers often
        // put a text/html fragment (containing an <img> tag) instead of raw image
        // bytes when the user copies an image from a web page.  Try that path first.
        const htmlItem = items.find(item => item.types.includes("text/html"));
        if (htmlItem) {
          const htmlBlob = await htmlItem.getType("text/html");
          await loadPastedImageFromHtml(await htmlBlob.text());
          return;
        }
        // Nothing usable found — fall back to the textarea paste-event path so
        // the OS paste gesture can deliver native bitmap formats (e.g. on Windows).
        pasteTarget.focus();
        setImageStatus("Paste an image using your device's paste gesture or Ctrl+V / Cmd+V.");
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

  document.addEventListener("paste", (event) => {
    const file = findImageInClipboard(event.clipboardData);
    if (file) {
      event.preventDefault();
      loadPastedImage(file);
      return;
    }
    // Browsers often copy images as text/html rather than image/* — check for that.
    const htmlItem = findHtmlItemInClipboardData(event.clipboardData);
    if (htmlItem) {
      event.preventDefault();
      htmlItem.getAsString((html) => loadPastedImageFromHtml(html));
    }
  });

  // Also listen on the contenteditable div so that paste events from a focused
  // element are captured in browsers (Bluefy, Edge, iOS Safari) that do not
  // reliably fire the document-level paste event without an active focusable
  // element.
  pasteTarget.addEventListener("paste", (event) => {
    event.preventDefault();
    const file = findImageInClipboard(event.clipboardData);
    if (file) {
      loadPastedImage(file);
      return;
    }
    // Browsers often copy images as text/html rather than image/* — check for that.
    const htmlItem = findHtmlItemInClipboardData(event.clipboardData);
    if (htmlItem) {
      htmlItem.getAsString((html) => loadPastedImageFromHtml(html));
    }
  });

  // Safari requires the Promise to be passed directly to ClipboardItem rather
  // than resolving it first.  If the blob is awaited before constructing
  // ClipboardItem the call falls outside the synchronous user-gesture frame
  // and Safari refuses to write to the clipboard.
  const copyOutputToClipboard = async () => {
    if (!state.render.envelope) {
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
    if (state.ble.connected) {
      await disconnectBle();
    } else {
      setSendStatus("Connecting to printer...");
      try {
        await connectBle();
      } catch (error) {
        console.error(error);
        setSendStatus(error instanceof Error ? error.message : String(error));
      }
    }
  });

  ui.sendBtn.addEventListener("click", async () => {
    try {
      await sendPreparedBitmap();
    } catch (error) {
      console.error(error);
    }
  });

  ui.feedBtn.addEventListener("click", async () => {
    try {
      await sendFeedRow();
    } catch (error) {
      console.error(error);
    }
  });

  ui.widthInput.addEventListener("input", renderJob);
  ui.heightInput.addEventListener("input", renderJob);
  ui.algorithmInput.addEventListener("input", renderJob);
  ui.bgColorInput.addEventListener("input", renderJob);
  ui.brightnessInput.addEventListener("input", renderJob);
  ui.contrastInput.addEventListener("input", renderJob);
  ui.thresholdInput.addEventListener("input", renderJob);

  updateThresholdVisibility();
  renderTextBlocksUI();
  renderJob();
}

const root = document.querySelector("#app");

if (!root) {
  throw new Error("Missing #app root element");
}

renderApp(root);

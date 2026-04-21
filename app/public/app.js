const MAX_WIDTH = 384;

const BLE_SCAFFOLD_STATE = {
  serviceUuid: "9f4d0001-8f5d-4f4c-8d3d-4f747072696e",
  writeCharacteristicUuid: "9f4d0002-8f5d-4f4c-8d3d-4f747072696e",
  notifyCharacteristicUuid: "9f4d0003-8f5d-4f4c-8d3d-4f747072696e"
};

const state = {
  fileName: "",
  image: null,
  sourceWidth: 0,
  sourceHeight: 0
};

function clampDimension(value) {
  if (!Number.isFinite(value)) {
    return MAX_WIDTH;
  }

  return Math.max(1, Math.min(MAX_WIDTH, Math.round(value)));
}

function calculateStrideBytes(width) {
  return Math.ceil(width / 8);
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

function ditherImage(grayscale, width, height, algorithm, threshold) {
  switch (algorithm) {
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

function renderApp(root) {
  root.innerHTML = `
    <main class="layout">
      <header class="hero">
        <p class="eyebrow">Cloudflare Pages app</p>
        <h1>Thermal image sender</h1>
        <p class="lede">
          Upload an image, scale it down to thermal-printer width, dither it in the browser,
          and preview the black-and-white result before BLE transport is added.
        </p>
      </header>

      <section class="card">
        <h2>Image pipeline</h2>
        <form id="job-form" class="grid">
          <label>
            Image file
            <input id="file-input" type="file" accept="image/*" />
          </label>
          <label class="paste-label">
            Paste from clipboard
            <button id="paste-btn" type="button">Paste image</button>
          </label>
          <label>
            Max output width
            <input id="width-input" type="number" min="1" max="${MAX_WIDTH}" value="${MAX_WIDTH}" />
          </label>
          <label>
            Dithering
            <select id="algorithm-input">
              <option value="floyd-steinberg">Floyd-Steinberg</option>
              <option value="ordered">Ordered Bayer</option>
              <option value="threshold">Threshold</option>
            </select>
          </label>
          <label>
            Background color
            <input id="bg-color-input" type="color" value="#ffffff" />
          </label>
          <label id="threshold-label">
            Threshold
            <input id="threshold-input" type="range" min="0" max="255" value="128" />
          </label>
        </form>
        <p id="threshold-value" class="meta"></p>
        <p id="status" class="status">Choose an image or paste one to begin.</p>
        <dl id="job-summary" class="summary"></dl>
      </section>

      <section class="preview-grid">
        <article class="card preview-card">
          <div class="card-header">
            <h2>Resized source</h2>
            <p class="meta">Scaled to the thermal output size before dithering.</p>
          </div>
          <div class="canvas-frame">
            <canvas id="source-canvas"></canvas>
          </div>
        </article>
        <article class="card preview-card">
          <div class="card-header">
            <h2>Dithered preview</h2>
            <p class="meta">Black-and-white output shown at the packed bitmap size.</p>
          </div>
          <div class="canvas-frame">
            <canvas id="output-canvas"></canvas>
          </div>
        </article>
      </section>

      <section class="card">
        <h2>Transport snapshot</h2>
        <p class="meta">Service UUID <code>${BLE_SCAFFOLD_STATE.serviceUuid}</code></p>
        <p class="meta">Write characteristic <code>${BLE_SCAFFOLD_STATE.writeCharacteristicUuid}</code></p>
        <p class="meta">Notify characteristic <code>${BLE_SCAFFOLD_STATE.notifyCharacteristicUuid}</code></p>
      </section>
    </main>
  `;

  const fileInput = root.querySelector("#file-input");
  const pasteBtn = root.querySelector("#paste-btn");
  const widthInput = root.querySelector("#width-input");
  const algorithmInput = root.querySelector("#algorithm-input");
  const bgColorInput = root.querySelector("#bg-color-input");
  const thresholdLabel = root.querySelector("#threshold-label");
  const thresholdInput = root.querySelector("#threshold-input");
  const thresholdValue = root.querySelector("#threshold-value");
  const status = root.querySelector("#status");
  const summary = root.querySelector("#job-summary");
  const sourceCanvas = root.querySelector("#source-canvas");
  const outputCanvas = root.querySelector("#output-canvas");

  if (
    !fileInput ||
    !pasteBtn ||
    !widthInput ||
    !algorithmInput ||
    !bgColorInput ||
    !thresholdLabel ||
    !thresholdInput ||
    !thresholdValue ||
    !status ||
    !summary ||
    !sourceCanvas ||
    !outputCanvas
  ) {
    throw new Error("Image pipeline UI failed to initialize");
  }

  const updateThresholdLabel = () => {
    thresholdValue.textContent = `Threshold: ${thresholdInput.value}`;
  };

  const updateThresholdVisibility = () => {
    const isThreshold = algorithmInput.value === "threshold";
    thresholdLabel.style.display = isThreshold ? "" : "none";
    thresholdValue.style.display = isThreshold ? "" : "none";
  };

  const renderJob = () => {
    updateThresholdLabel();
    updateThresholdVisibility();

    if (!state.image) {
      summary.innerHTML = "";
      return;
    }

    const requestedWidth = clampDimension(Number(widthInput.value));
    const { width, height } = calculateTargetSize(
      state.sourceWidth,
      state.sourceHeight,
      requestedWidth
    );

    widthInput.value = String(width);

    const bgColor = bgColorInput.value;
    drawSourceToCanvas(state.image, sourceCanvas, width, height, bgColor);
    const sourceContext = sourceCanvas.getContext("2d");

    if (!sourceContext) {
      throw new Error("Missing source canvas context");
    }

    const imageData = sourceContext.getImageData(0, 0, width, height);
    const grayscale = toGrayscale(imageData);
    const algorithm = algorithmInput.value;
    const threshold = Number(thresholdInput.value);
    const dithered = ditherImage(grayscale, width, height, algorithm, threshold);

    renderBinaryPreview(outputCanvas, width, height, dithered);

    const packedBitmap = packMonochrome(dithered, width, height);
    const envelope = buildEnvelope(width, height);

    status.textContent = `Prepared ${state.fileName} at ${width} x ${height} using ${algorithm}.`;
    summary.innerHTML = `
      <div>
        <dt>Source</dt>
        <dd>${state.sourceWidth} x ${state.sourceHeight}</dd>
      </div>
      <div>
        <dt>Output</dt>
        <dd>${width} x ${height}</dd>
      </div>
      <div>
        <dt>Stride</dt>
        <dd>${envelope.strideBytes} bytes/row</dd>
      </div>
      <div>
        <dt>Payload</dt>
        <dd>${envelope.payloadLength} bytes</dd>
      </div>
      <div>
        <dt>Packed buffer</dt>
        <dd>${packedBitmap.length} bytes</dd>
      </div>
      <div>
        <dt>Threshold</dt>
        <dd>${threshold}</dd>
      </div>
    `;
  };

  const applyImageSource = (image, name) => {
    state.image = image;
    state.fileName = name;
    state.sourceWidth = image.naturalWidth || image.width;
    state.sourceHeight = image.naturalHeight || image.height;
    renderJob();
  };

  fileInput.addEventListener("change", async () => {
    const [file] = fileInput.files ?? [];

    if (!file) {
      return;
    }

    status.textContent = `Loading ${file.name}...`;

    try {
      const image = await loadImageFromFile(file);
      applyImageSource(image, file.name);
    } catch (error) {
      console.error(error);
      status.textContent = "Unable to load the selected image.";
    }
  });

  pasteBtn.addEventListener("click", async () => {
    status.textContent = "Reading clipboard...";

    try {
      const items = await navigator.clipboard.read();
      const imageItem = items.find(item => item.types.some(type => type.startsWith("image/")));

      if (!imageItem) {
        status.textContent = "No image found in clipboard.";
        return;
      }

      const imageType = imageItem.types.find(type => type.startsWith("image/"));
      const blob = await imageItem.getType(imageType);
      const image = await loadImageFromFile(new File([blob], "clipboard", { type: imageType }));
      applyImageSource(image, "clipboard");
    } catch (error) {
      console.error(error);
      status.textContent = "Unable to read clipboard. Try pressing Ctrl+V / Cmd+V instead.";
    }
  });

  document.addEventListener("paste", async (event) => {
    const items = [...(event.clipboardData?.items ?? [])];
    const imageItem = items.find(item => item.type.startsWith("image/"));

    if (!imageItem) {
      return;
    }

    const file = imageItem.getAsFile();

    if (!file) {
      return;
    }

    status.textContent = "Loading pasted image...";

    try {
      const image = await loadImageFromFile(file);
      applyImageSource(image, "clipboard");
    } catch (error) {
      console.error(error);
      status.textContent = "Unable to load the pasted image.";
    }
  });

  widthInput.addEventListener("input", renderJob);
  algorithmInput.addEventListener("input", renderJob);
  bgColorInput.addEventListener("input", renderJob);
  thresholdInput.addEventListener("input", renderJob);

  updateThresholdLabel();
  updateThresholdVisibility();
}

const root = document.querySelector("#app");

if (!root) {
  throw new Error("Missing #app root element");
}

renderApp(root);

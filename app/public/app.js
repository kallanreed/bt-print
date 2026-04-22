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

function renderApp(root) {
  root.innerHTML = `
    <main class="layout">
      <header class="hero">
        <h1>bt&#8209;print</h1>
        <p class="lede">Upload an image and preview it as a dithered bitmap for thermal printing.</p>
      </header>

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
              <option value="floyd-steinberg">Floyd-Steinberg</option>
              <option value="atkinson">Atkinson</option>
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

      <section class="preview-grid">
        <details class="card preview-card" open>
          <summary>Resized source</summary>
          <div class="canvas-frame">
            <canvas id="source-canvas"></canvas>
          </div>
        </details>
        <article class="card preview-card">
          <h2>Dithered preview</h2>
          <div class="canvas-frame">
            <canvas id="output-canvas"></canvas>
          </div>
          <button id="copy-btn" type="button">Copy to clipboard</button>
        </article>
      </section>

      <dl id="job-summary" class="summary"></dl>

      <details class="card transport-card">
        <summary>Transport details</summary>
        <p class="meta">Service UUID <code>${BLE_SCAFFOLD_STATE.serviceUuid}</code></p>
        <p class="meta">Write characteristic <code>${BLE_SCAFFOLD_STATE.writeCharacteristicUuid}</code></p>
        <p class="meta">Notify characteristic <code>${BLE_SCAFFOLD_STATE.notifyCharacteristicUuid}</code></p>
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
  const sourceCanvas = root.querySelector("#source-canvas");
  const outputCanvas = root.querySelector("#output-canvas");
  const copyBtn = root.querySelector("#copy-btn");

  // Hidden off-screen textarea used as a reliable paste-event sink on mobile
  // browsers (Bluefy, Edge) where document-level paste events only fire when
  // a focusable element is active.
  const pasteTarget = document.createElement("textarea");
  pasteTarget.id = "paste-target";
  pasteTarget.setAttribute("aria-label", "Paste image here");
  pasteTarget.setAttribute("tabindex", "-1");
  document.body.appendChild(pasteTarget);

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
    !sourceCanvas ||
    !outputCanvas ||
    !copyBtn
  ) {
    throw new Error("Image pipeline UI failed to initialize");
  }

  const updateSliderDisplays = () => {
    brightnessDisplay.textContent = brightnessInput.value;
    contrastDisplay.textContent = contrastInput.value;
    thresholdDisplay.textContent = thresholdInput.value;
  };

  const updateThresholdVisibility = () => {
    thresholdRow.style.display = algorithmInput.value === "threshold" ? "" : "none";
  };

  const renderJob = () => {
    updateSliderDisplays();
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
    const rawGrayscale = toGrayscale(imageData);
    const brightness = Number(brightnessInput.value);
    const contrast = Number(contrastInput.value);
    const grayscale = applyBrightnessContrast(rawGrayscale, brightness, contrast);
    const algorithm = algorithmInput.value;
    const threshold = Number(thresholdInput.value);
    const dithered = ditherImage(grayscale, width, height, algorithm, threshold);

    renderBinaryPreview(outputCanvas, width, height, dithered);

    const packedBitmap = packMonochrome(dithered, width, height);
    const envelope = buildEnvelope(width, height);

    status.textContent = `Ready — ${state.fileName}, ${width} \u00d7 ${height} px, ${algorithm}.`;
    summary.innerHTML = `
      <div>
        <dt>Source</dt>
        <dd>${state.sourceWidth} \u00d7 ${state.sourceHeight}</dd>
      </div>
      <div>
        <dt>Output</dt>
        <dd>${width} \u00d7 ${height}</dd>
      </div>
      <div>
        <dt>Stride</dt>
        <dd>${envelope.strideBytes} B/row</dd>
      </div>
      <div>
        <dt>Payload</dt>
        <dd>${packedBitmap.length} B</dd>
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

    status.textContent = `Loading ${file.name}\u2026`;

    try {
      const image = await loadImageFromFile(file);
      applyImageSource(image, file.name);
    } catch (error) {
      console.error(error);
      status.textContent = "Unable to load the selected image.";
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

    status.textContent = "Loading pasted image\u2026";

    try {
      const image = await loadImageFromFile(file);
      applyImageSource(image, "clipboard");
    } catch (error) {
      console.error(error);
      status.textContent = "Unable to load the pasted image.";
    }

    return true;
  };

  pasteBtn.addEventListener("click", async () => {
    status.textContent = "Reading clipboard\u2026";

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
      // clipboard.read() is blocked on most mobile browsers.  Focus the
      // off-screen textarea so the OS paste gesture delivers its paste event
      // to a concrete element, which works more reliably than relying on the
      // document-level paste event in Bluefy / Edge / Safari.
      pasteTarget.focus();
      status.textContent = "Paste an image using your device\u2019s paste gesture or Ctrl+V / Cmd+V.";
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
      status.textContent = "Output copied to clipboard.";
    } catch (error) {
      console.error(error);
      status.textContent = "Unable to copy output to clipboard.";
    }
  };

  outputCanvas.addEventListener("click", copyOutputToClipboard);
  copyBtn.addEventListener("click", copyOutputToClipboard);

  widthInput.addEventListener("input", renderJob);
  algorithmInput.addEventListener("input", renderJob);
  bgColorInput.addEventListener("input", renderJob);
  brightnessInput.addEventListener("input", renderJob);
  contrastInput.addEventListener("input", renderJob);
  thresholdInput.addEventListener("input", renderJob);

  updateSliderDisplays();
  updateThresholdVisibility();
}

const root = document.querySelector("#app");

if (!root) {
  throw new Error("Missing #app root element");
}

renderApp(root);

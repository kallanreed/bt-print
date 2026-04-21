# ESP32 Thermal Printer Project Plan

## Goal

Build a two-part system:

1. **Firmware (`firmware/`)** for an ESP32 using PlatformIO that accepts a BLE image transfer, decodes a monochrome bitmap up to 384 pixels wide, and sends the correct UART command stream to a thermal printer.
2. **Web app (`app/`)** as a Cloudflare Pages-hosted SPA that imports, uploads, or captures an image, converts it into a black-and-white bitmap optimized for thermal printing, previews the result, and sends it to the ESP32 over BLE.

## Current assumptions

- BLE is the transport between the SPA and the ESP32.
- The app sends image data as **base64-encoded binary**.
- The BLE payload should use a **packetized protocol** with an explicit **packet type** field so data packets and control packets are distinguishable.
- The image-transfer packet sequence should include a **minimal envelope** describing image dimensions before bitmap data.
- The firmware primarily needs to support **384x384** monochrome bitmaps, while allowing any width up to **384 pixels**.
- Bitmap payloads should use **byte-aligned row strides**: each row is padded to full bytes, even when the logical width is not a multiple of 8.
- UART is the link between the ESP32 and the thermal printer.
- `docs/mini-thermal-receipt-printer.pdf` is the current printer reference; additional printer and chip documentation will refine command handling and hardware-specific details.

## System shape

### Firmware flow

BLE client connection -> envelope validation -> chunk reception -> base64 decode -> bitmap validation/buffering -> raster-to-printer command conversion -> UART print job

### Web app flow

Image source (upload/import/camera) -> crop/resize -> monochrome conversion + dithering -> preview -> BLE connection -> envelope + bitmap transmission

## Workstreams

### 1. Protocol and data contract

- Define the BLE service and characteristic layout.
- Define the packet header, including at minimum a **packet type** and enough metadata for transfer/job correlation.
- Define the message envelope for width, height, payload length, and job boundaries.
- Use a **packed 1-bit bitmap with per-row byte padding** so stride is always `ceil(width / 8)` bytes.
- Reserve packet types for both image data and control flow, including at least **reset/cancel** handling for stalled transfers.
- Define chunk sizing, sequencing, completion, and error signaling.
- Decide whether acknowledgements are per chunk, per frame, or only on final commit.

### 2. Firmware foundation

- Bootstrap a PlatformIO ESP32 project in `firmware/`.
- Select the BLE and base64 support approach.
- Add printer UART configuration, job state handling, and memory limits for the image buffer.
- Design for predictable handling of malformed payloads and interrupted transfers.

### 3. Printer integration

- Extract printer initialization, raster/bitmap, and feed commands from the printer documentation.
- Confirm UART settings, timing, and any printer buffer constraints.
- Map the monochrome bitmap format into the byte order expected by the printer.
- Capture open questions for chip-level documentation once it is provided.

### 4. SPA foundation

- Bootstrap the SPA in `app/` for Cloudflare Pages deployment.
- Add browser BLE integration and a clean local development workflow.
- Structure the UI around image preparation, preview, connection state, and send progress.

### 5. Image processing pipeline

- Support file upload, import, and camera capture.
- Normalize orientation and dimensions before conversion.
- Resize images to thermal-printer-friendly output, with 384-pixel width as the primary target.
- Evaluate monochrome conversion and dithering options for good visual separation in black and white.
- Generate the final packed bitmap used by the BLE sender.
- Pad the last byte of each row when width is not divisible by 8 rather than using a tighter bitstream.

### 6. End-to-end verification and documentation

- Validate the app-to-firmware payload contract with representative images.
- Validate printer output quality with common 384x384 jobs.
- Document the end-to-end flow, setup, and hardware assumptions as implementation lands.

## Todo list

- [ ] Define the BLE protocol, image envelope, and transfer lifecycle.
- [ ] Create the PlatformIO ESP32 firmware project in `firmware/`.
- [ ] Implement BLE connection handling, chunk reception, and base64 decoding in firmware.
- [ ] Implement bitmap validation and buffering for monochrome images up to 384 pixels wide.
- [ ] Implement UART printer command generation and print execution.
- [ ] Validate printer commands and serial settings against the documentation in `docs/`.
- [ ] Create the Cloudflare Pages SPA in `app/`.
- [ ] Build image acquisition flows for upload, import, and camera capture.
- [ ] Implement resize, monochrome conversion, and dithering tuned for thermal output.
- [ ] Build preview, BLE connection, and send-progress UI.
- [ ] Test end-to-end transfer and printing with typical 384x384 jobs.
- [ ] Document the final protocol and developer setup once the first working slice is complete.

## Recommended implementation order

1. Define the BLE contract before writing sender/receiver code.
2. Bootstrap the firmware and extract printer command requirements from the documentation.
3. Stand up the SPA shell and image-processing pipeline.
4. Connect the SPA sender to the firmware receiver with a fixed test image.
5. Complete printer output, then iterate on image quality and UX.

## Open inputs still expected

- Additional printer documentation.
- Documentation for the printer controller chips or print-head electronics.
- Any hardware constraints around power delivery, baud rate limits, or printer buffer behavior that are not covered in the current PDF.

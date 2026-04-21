# Mini Thermal Receipt Printer Implementation Notes

Source: `docs/mini-thermal-receipt-printer.pdf` (Adafruit guide, updated 2024-06-03)

## What matters for this project

This guide is most useful for:

- electrical and power constraints
- UART/TTL serial integration details
- firmware-version and baud-rate discovery
- monochrome bitmap constraints
- printer buffer / throughput behavior

It is **not** a raw printer command reference. For exact byte-level command generation, we will likely still need printer chipset documentation or to inspect an existing library implementation.

## Power and electrical constraints

- The printer requires **5V to 9V DC** at **2A minimum**.
- A **5V 2A supply is considered a baseline**, but the guide notes that brownouts are possible if the microcontroller shares that supply during heavy printing.
- Higher-current supplies can improve print darkness and feed assertiveness.
- **Never exceed 9V**; the guide explicitly warns that 12V+ can permanently damage the printer.

### Firmware/hardware implication

- Plan around a **separate, robust printer power path** rather than assuming USB power is enough.
- Treat printer current draw as a design constraint for any ESP32 + printer enclosure or battery setup.

## UART / TTL serial integration

- The printer uses **3.3V to 5V TTL serial**, **not RS232**.
- The guide says the printer logic is **3.3V and 5V tolerant**, and older level-shifting guidance is no longer generally required on the printer input side.
- The printer data cable exposes at least:
  - **printer RX** = data into the printer
  - **printer TX** = data out of the printer
  - **GND**
- Wire colors differ by printer model, so the PCB labels / model-specific pinout must be checked before hardware bring-up.

### ESP32 wiring implication

- The minimum working path is:
  - ESP32 **TX -> printer RX**
  - common **GND**
- **ESP32 RX <- printer TX** is optional for initial printing, but useful for paper-status queries and possibly other bidirectional features.
- The guide’s CircuitPython example warns that the printer TX side may be **5V on some setups**, so confirm voltage behavior on the actual hardware before wiring printer TX directly into an ESP32 RX pin.

## Baud rate and printer firmware version

- The guide recommends printing the printer’s **self-test page** by holding the button while applying power.
- From that page, record:
  - **baud rate** — typically **19200** or **9600**
  - **firmware version** — examples include **2.2, 2.64, 2.68**
- If the test page does not show the baud rate, the guide suggests trying **9600 first**, then **19200**.

### Firmware implication

- Our ESP32 firmware should make the printer UART baud rate **configurable**, with **19200** and **9600** as first-class supported options.
- During hardware bring-up, the self-test page should be treated as the source of truth for initial UART config.

## Bitmap printing constraints

- The printer supports **monochrome (1-bit)** images only.
- The **maximum width is 384 pixels**.
- Width should be treated as a multiple of **8 pixels**:
  - if an image width is not divisible by 8, the common tooling truncates or pads to the nearest 8-pixel boundary.
- The guide recommends starting with smaller images first, then scaling up.
- For this project, the transport format should **pad each row to a whole number of bytes** instead of trying to save bits on non-8-aligned widths.

### Firmware implication

- The BLE transport should be a **packet protocol**, not a raw byte stream.
- Each packet should include a **packet type** so the receiver can distinguish control packets from image payload packets.
- The first protocol revision should reserve packet types for at least:
  - transfer start / image header
  - data chunk
  - transfer commit / end
  - reset or cancel
  - acknowledgement / error status
- The BLE image envelope should include:
  - width
  - height
  - payload length
- A **reset** packet should clear the active transfer state so the app can recover from stalled or abandoned sends without requiring a reconnect.
- The firmware should reject images where:
  - width > 384
  - payload rows are not encoded with the agreed byte-aligned stride
  - payload length does not match `ceil(width / 8) * height`
- The protocol should treat stride as **`ceil(width / 8)` bytes per row**, with unused bits in the last byte padded.
- For the app pipeline, the safest default is to **normalize output width to a multiple of 8**, with **384** as the main target, but non-8-aligned logical widths can still be represented with padded row bytes.

## Print quality and image-processing constraints

- The guide explicitly warns that these printers are **not good at heavy/dense images with lots of black**.
- Best results come from:
  - **light line art**
  - **dithered photos**
  - keeping overall dot density **fairly low** (the guide suggests under roughly **50%**)
- Large solid black fills can cause:
  - streaking
  - vertically squashed output
  - jams / print artifacts

### App implication

- The SPA should prioritize:
  - aggressive resize control
  - monochrome conversion tuned for thermal output
  - dithering over naive thresholding for most photographic inputs
  - previewing the final 1-bit result before send

## Printer receive-buffer and flow-control behavior

- The guide says the printer has a **limited serial receive buffer**.
- If data is sent faster than the mechanism can heat/feed, overflows can cause:
  - garbled bitmaps
  - skipped text/format commands
- Adafruit’s library works around this with **software throttling**.

### Firmware implication

- Our ESP32 printer driver cannot just dump the full decoded bitmap to UART as fast as possible.
- It needs either:
  - **careful pacing/throttling**, or
  - **hardware handshaking** if the printer model supports it and we wire the signal
- The BLE side should also maintain explicit transfer state so a **reset packet** can abort an in-progress job before any partial buffer is printed.

## DTR / handshaking support

- The guide says some printer variants / firmware versions support a ready signal commonly labeled **DTR** in the guide, though it is technically closer to **CTS** behavior.
- On:
  - **Tiny**
  - **Nano**
  - **Printer Guts**
  
  the DTR pin is exposed already.
- On at least some **Mini** printers, the guide describes an internal hardware modification to expose DTR.
- With DTR connected, the host can send data at higher sustained throughput with fewer overflow issues.

### Firmware/hardware implication

- The first firmware slice should assume **TX-only + software pacing**.
- If the actual printer hardware exposes DTR, we should consider a later revision that adds:
  - optional DTR GPIO wiring
  - a handshake-aware UART send loop

## Optional paper-status support

- The guide shows a `has_paper()` capability on some printers / firmware versions.
- This requires the host to read from the printer TX line.
- The guide notes that support varies by printer and firmware release.

### Firmware implication

- Treat paper-status reporting as **optional**, not part of the first printing milestone.
- It is a good follow-up feature if we decide to wire printer TX safely into the ESP32.

## Practical implementation takeaways for this repo

### Firmware (`firmware/`)

- Use **PlatformIO** with an ESP32 target.
- Model the printer side as a UART raster device with:
  - configurable baud
  - bounded image validation
  - paced row/chunk transmission
- Start with **one-way printing** from ESP32 to printer.
- Keep DTR and paper-status support behind optional hardware capabilities.

### App (`app/`)

- Emit **1-bit packed bitmaps** only.
- Default to **384-pixel-wide** output where possible.
- Ensure output width is **8-pixel aligned**.
- Optimize for **dithered, low-density imagery** instead of solid black fills.

## Open questions this PDF does not settle

- Exact byte-level printer commands for raster image output
- Preferred command set for our specific printer model/chipset
- Exact warm-up / inter-line pacing values we should use from custom firmware
- Whether the specific hardware unit we use exposes DTR without modification
- Safe voltage level for printer TX on the exact unit we wire to the ESP32

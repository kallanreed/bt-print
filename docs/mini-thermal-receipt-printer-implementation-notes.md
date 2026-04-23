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

## ESC/POS command reference

Derived from `docs/Adafruit_Thermal.h` and the Adafruit_Thermal library source.
These are the commands actually used by the Adafruit thermal printer family.

### Confirmed hardware settings (our unit)

- **Baud rate: 19200** (read from self-test page)
- **UART: Serial2 on ESP32, GPIO17 TX**

### Command bytes

| Purpose | Bytes | Notes |
|---------|-------|-------|
| Initialize | `1B 40` | ESC @ — resets all settings; send on startup |
| Heat config | `1B 37 n1 n2 n3` | ESC 7 — n1=max dots (8 dots/step), n2=heat time (10 µs/step), n3=heat interval (10 µs/step) |
| Print density | `12 23 n` | DC2 # — n = `(breakTime << 5) \| density` |
| **Print bitmap row** | `12 2A rows stride [data…]` | DC2 * — rows up to 255, stride = ceil(width/8), data is rows×stride bytes |
| Feed text lines | `1B 64 n` | ESC d — feeds n text lines |
| Feed dot rows | `1B 4A n` | ESC J — feeds n individual dot rows |

### Recommended init values (from Adafruit library defaults)

```
Heat config:    1B 37 0B 78 28   (dots=11, time=120×10µs=1200µs, interval=40×10µs=400µs)
Print density:  12 23 4A         (breakTime=2, density=10  →  (2<<5)|10 = 0x4A)
```

### Bitmap format

- 1 bit per pixel, **MSB first** — bit 7 of byte 0 is the leftmost pixel
- **1 = black dot, 0 = white** (no dot)
- Row stride = `ceil(width / 8)` bytes; 384 px wide → 48 bytes/row
- Send via DC2 * with `rows=1` per call and wait 30 ms between rows (see throttling below)

### Timing constants (firmware 2.68, also correct for 2.2)

| Constant | Value | Meaning |
|----------|-------|---------|
| `dotPrintTime` | 30 000 µs | Minimum time per printed dot row |
| `dotFeedTime` | 2 100 µs | Time per fed dot row |
| `charHeight` | 24 dots | Default text line height in dot rows |

ESC d 3 lines → wait `3 × 24 × 2100 µs = 151 200 µs` (~151 ms).

### Throttling — critical

The printer's serial receive buffer is small (estimated ~256 bytes for CSN-A2 chipset).
Sending a full row's worth of data at UART speed is safe; sending multiple rows at once
overflows the buffer silently and produces a blank print.

**Required approach: one dot row per DC2 * command, 30 ms between rows.**

At 19200 baud, transmitting one row (48 bytes + 4-byte header = 52 bytes) takes ~27 ms,
which fits within the 30 ms print budget. The printer is never ahead of the sender.

### Mini (#597) cable pinout

- **Black = GND**
- **Yellow = printer RX** (data in — connect to ESP32 TX)
- **Green = printer TX** (data out — optional, needed for paper status only)

## Open questions this PDF does not settle

- Whether our specific unit exposes DTR without hardware modification
- Safe voltage level for printer TX on our exact unit (may be 5V — check before wiring to ESP32 RX)

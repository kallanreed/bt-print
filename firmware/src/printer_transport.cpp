#include "printer_transport.h"

#include <string.h>

namespace bt_print {

PrinterTransport::PrinterTransport(HardwareSerial& serial)
    : serial_(serial), printer_(&serial) {}

void PrinterTransport::Begin(
    const int8_t txPin,
    const int8_t rxPin,
    const uint32_t baudRate) {
  serial_.begin(baudRate, SERIAL_8N1, rxPin, txPin);
  delay(50);
  printer_.begin();
  // Use a gentler print profile while bringing up raster mode so we can
  // distinguish protocol problems from power/current-limit problems.
  printer_.setHeatConfig(7, 120, 120);
  printer_.setPrintDensity(14, 4);
  // Our printer only behaved reliably when raster output was limited to a
  // single dot row per DC2 * command.
  printer_.setMaxChunkHeight(1);
}

void PrinterTransport::Configure(const PrinterConfig& config) {
  Serial.printf(
      "printer: configure dots=%u time=%u interval=%u\n",
      static_cast<unsigned>(config.heatDots),
      static_cast<unsigned>(config.heatTime),
      static_cast<unsigned>(config.heatInterval));
  printer_.setHeatConfig(config.heatDots, config.heatTime, config.heatInterval);
}

void PrinterTransport::Poll() {}

void PrinterTransport::Feed(const uint8_t lines) {
  Serial.printf("printer-debug: Feed lines=%u\n", static_cast<unsigned>(lines));
  printer_.feed(lines);
}

void PrinterTransport::PrintImage(
    const uint8_t* bitmap,
    const ImageEnvelope& envelope) {
  if (bitmap == nullptr || envelope.width == 0 || envelope.height == 0 ||
      envelope.strideBytes == 0 ||
      envelope.strideBytes > UINT8_MAX) {
    Serial.println("printer: invalid image envelope");
    return;
  }

  Serial.printf(
      "printer-debug: PrintImage width=%u height=%u stride=%u payload=%lu\n",
      static_cast<unsigned>(envelope.width),
      static_cast<unsigned>(envelope.height),
      static_cast<unsigned>(envelope.strideBytes),
      static_cast<unsigned long>(envelope.payloadLength));
  printer_.printBitmap(envelope.width, envelope.height, bitmap, false);
  Serial.println("printer-debug: PrintImage done");
}

void PrinterTransport::PrintLine(const char* text) {
  if (text == nullptr) {
    return;
  }

  Serial.printf("printer-debug: PrintLine text=\"%s\"\n", text);
  printer_.println(text);
}

void PrinterTransport::PrintRasterProbe() {
  constexpr uint16_t kWidth = 384;
  constexpr uint16_t kHeight = 10;
  constexpr uint16_t kStride = kWidth / 8;
  constexpr uint8_t kPatterns[] = {
      0x80, 0xC0, 0xE0, 0xF0, 0xF8, 0xFC, 0xFE, 0xFF};

  uint8_t patternRows[kStride * kHeight];

  const ImageEnvelope envelope = {
      kWidth, kHeight, kStride, static_cast<uint32_t>(kStride * kHeight)};

  for (const uint8_t pattern : kPatterns) {
    memset(patternRows, pattern, sizeof(patternRows));
    Serial.printf("printer: raster probe 0x%02X x10\n", static_cast<unsigned>(pattern));
    PrintImage(patternRows, envelope);
    printer_.feedRows(8);
    delay(250);
  }
}

void PrinterTransport::PrintTestPattern() {
  constexpr uint16_t kWidth = 384;
  constexpr uint16_t kHeight = 5;
  constexpr uint16_t kStride = kWidth / 8;

  uint8_t bitmap[kStride * kHeight];
  memset(bitmap, 0xFF, sizeof(bitmap));

  const ImageEnvelope envelope = {
      kWidth, kHeight, kStride, static_cast<uint32_t>(kStride * kHeight)};

  Serial.println("printer: sending test pattern");
  PrintImage(bitmap, envelope);
}

}  // namespace bt_print

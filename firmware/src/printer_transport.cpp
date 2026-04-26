#include "printer_transport.h"

namespace bt_print {

namespace {

constexpr uint16_t kPrinterWidthDots = 384;
constexpr uint8_t kDotsPerHeatGroup = 8;
constexpr uint32_t kHeatUnitUs = 10;
constexpr uint32_t kReferenceFeedTimeUs = 2100;
constexpr uint32_t kPrintEstimateOffsetUs = 18000;

uint32_t ClampEstimateUs(const uint32_t value) {
  if (value == 0) {
    return 1;
  }

  return value;
}

uint32_t HeatGroupWidthDots(const uint8_t heatDots) {
  return static_cast<uint32_t>(heatDots + 1U) * kDotsPerHeatGroup;
}

uint32_t RowSectionCount(const PrinterConfig& config) {
  const uint32_t sectionWidthDots = HeatGroupWidthDots(config.heatDots);
  return (kPrinterWidthDots + sectionWidthDots - 1U) / sectionWidthDots;
}

uint32_t SectionCycleUs(const PrinterConfig& config) {
  return static_cast<uint32_t>(config.heatTime + config.heatInterval) * kHeatUnitUs;
}

uint32_t RowWorkUs(const PrinterConfig& config) {
  return RowSectionCount(config) * SectionCycleUs(config);
}

uint32_t EstimatePrintTimeUs(const PrinterConfig& config) {
  uint64_t estimate = static_cast<uint64_t>(RowWorkUs(config)) + kPrintEstimateOffsetUs;
  return ClampEstimateUs(static_cast<uint32_t>(estimate));
}

uint32_t EstimateFeedTimeUs() {
  return kReferenceFeedTimeUs;
}

PrinterConfig DefaultPrinterConfig() {
  return PrinterConfig{
      7,
      120,
      120,
      12,
      4,
      0,
      0,
      0,
  };
}

}  // namespace

PrinterTransport::PrinterTransport(HardwareSerial& serial)
    : currentConfig_(DefaultPrinterConfig()), serial_(serial), printer_(&serial) {}

void PrinterTransport::Begin(
    const int8_t txPin,
    const int8_t rxPin,
    const uint32_t baudRate) {
  serial_.begin(baudRate, SERIAL_8N1, rxPin, txPin);
  delay(50);
  printer_.begin();
  Configure(currentConfig_);
  printer_.setMaxChunkHeight(1);
}

void PrinterTransport::Configure(const PrinterConfig& config) {
  const uint32_t effectivePrintSpeed =
      config.printSpeed != 0 ? config.printSpeed : EstimatePrintTimeUs(config);
  const uint32_t effectiveFeedSpeed =
      config.feedSpeed != 0 ? config.feedSpeed : EstimateFeedTimeUs();

  Serial.printf(
      "printer: configure dots=%u time=%u interval=%u density=%u break=%u print=%u->%lu feed=%u->%lu prefeedrows=%u\n",
      static_cast<unsigned>(config.heatDots),
      static_cast<unsigned>(config.heatTime),
      static_cast<unsigned>(config.heatInterval),
      static_cast<unsigned>(config.density),
      static_cast<unsigned>(config.breakTime),
      static_cast<unsigned>(config.printSpeed),
      static_cast<unsigned long>(effectivePrintSpeed),
      static_cast<unsigned>(config.feedSpeed),
      static_cast<unsigned long>(effectiveFeedSpeed),
      static_cast<unsigned>(config.preFeedRows));
  currentConfig_ = config;
  printer_.setHeatConfig(config.heatDots, config.heatTime, config.heatInterval);
  printer_.setPrintDensity(config.density, config.breakTime);
  printer_.setTimes(effectivePrintSpeed, effectiveFeedSpeed);
}

void PrinterTransport::Poll() {}

void PrinterTransport::Feed(const uint8_t lines) {
  printer_.feed(lines);
  printer_.timeoutWait();
}

void PrinterTransport::FeedRows(const uint8_t rows) {
  printer_.feedRows(rows);
  printer_.timeoutWait();
}

void PrinterTransport::PrintImage(
    const uint8_t* bitmap,
    const ImageEnvelope& envelope,
    const bool preFeedBeforeImage) {
  if (bitmap == nullptr || envelope.width == 0 || envelope.height == 0 ||
      envelope.strideBytes == 0 ||
      envelope.strideBytes > UINT8_MAX) {
    Serial.println("printer: invalid image envelope");
    return;
  }

  if (preFeedBeforeImage && currentConfig_.preFeedRows != 0) {
    printer_.feedRows(currentConfig_.preFeedRows);
  }
  printer_.printBitmap(envelope.width, envelope.height, bitmap, false);
}

void PrinterTransport::PrintLine(const char* text) {
  if (text == nullptr) {
    return;
  }

  printer_.println(text);
}

}  // namespace bt_print

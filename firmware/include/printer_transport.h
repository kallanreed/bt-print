#pragma once

#include <Arduino.h>

#include "Adafruit_Thermal.h"
#include "ble_protocol.h"

namespace bt_print {

class PrinterTransport {
 public:
  explicit PrinterTransport(HardwareSerial& serial);

  void Begin(int8_t txPin, int8_t rxPin, uint32_t baudRate);
  void Poll();

  void Configure(const PrinterConfig& config);
  void PrintImage(
      const uint8_t* bitmap,
      const ImageEnvelope& envelope,
      bool preFeedBeforeImage = false);
  void PrintLine(const char* text);
  void Feed(uint8_t lines = 3);

 private:
  PrinterConfig currentConfig_{};

  HardwareSerial& serial_;
  Adafruit_Thermal printer_;
};

}  // namespace bt_print

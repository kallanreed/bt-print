#pragma once

#include <Arduino.h>

#include "ble_protocol.h"

namespace bt_print {

class PrinterTransport {
 public:
  explicit PrinterTransport(HardwareSerial& serial);

  void Begin(int8_t txPin, int8_t rxPin, uint32_t baudRate);
  void Poll();
  void NoteReadyImage(const ImageEnvelope& envelope);

 private:
  HardwareSerial& serial_;
};

}  // namespace bt_print

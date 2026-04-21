#include "printer_transport.h"

namespace bt_print {

PrinterTransport::PrinterTransport(HardwareSerial& serial) : serial_(serial) {}

void PrinterTransport::Begin(
    const int8_t txPin,
    const int8_t rxPin,
    const uint32_t baudRate) {
  serial_.begin(baudRate, SERIAL_8N1, rxPin, txPin);
}

void PrinterTransport::Poll() {}

void PrinterTransport::NoteReadyImage(const ImageEnvelope& envelope) {
  serial_.printf(
      "queued-image width=%u height=%u stride=%u payload=%lu\n",
      envelope.width,
      envelope.height,
      envelope.strideBytes,
      static_cast<unsigned long>(envelope.payloadLength));
}

}  // namespace bt_print

#include <Arduino.h>

#include "app_config.h"
#include "ble_protocol.h"
#include "ble_service.h"
#include "printer_transport.h"
#include "transfer_session.h"

namespace {

bt_print::BleService bleService;
bt_print::TransferSession transferSession;
bt_print::PrinterTransport printerTransport(Serial2);

}  // namespace

void setup() {
  Serial.begin(115200);
  delay(200);

  Serial.println("bt-print firmware scaffold booting");
  Serial.printf(
      "max-image-width=%u default-job=%ux%u printer-baud=%lu\n",
      bt_print::config::kMaxImageWidthPx,
      bt_print::config::kDefaultImageWidthPx,
      bt_print::config::kDefaultImageHeightPx,
      static_cast<unsigned long>(bt_print::config::kDefaultPrinterBaudRate));

  transferSession.Reset();
  bleService.Begin();
  printerTransport.Begin(
      bt_print::config::kPrinterTxPin,
      bt_print::config::kPrinterRxPin,
      bt_print::config::kDefaultPrinterBaudRate);
  const auto defaultStride = bt_print::CalculateStrideBytes(
      bt_print::config::kDefaultImageWidthPx);
  const auto defaultPayload = bt_print::CalculatePayloadLength(
      bt_print::config::kDefaultImageWidthPx,
      bt_print::config::kDefaultImageHeightPx);

  Serial.printf(
      "packet-types=%s,%s,%s,%s,%s,%s stride=%u payload=%lu\n",
      bt_print::PacketTypeName(bt_print::PacketType::kTransferStart),
      bt_print::PacketTypeName(bt_print::PacketType::kDataChunk),
      bt_print::PacketTypeName(bt_print::PacketType::kTransferCommit),
      bt_print::PacketTypeName(bt_print::PacketType::kReset),
      bt_print::PacketTypeName(bt_print::PacketType::kAck),
      bt_print::PacketTypeName(bt_print::PacketType::kError),
      defaultStride,
      static_cast<unsigned long>(defaultPayload));
}

void loop() {
  bleService.Poll(transferSession);
  printerTransport.Poll();
  delay(50);
}

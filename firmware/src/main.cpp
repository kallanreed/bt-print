#include <Arduino.h>

#include "app_config.h"
#include "ble_protocol.h"
#include "ble_service.h"
#include "printer_transport.h"
#include "transfer_session.h"

#ifndef PIO_UNIT_TESTING

namespace {

bt_print::BleService bleService;
bt_print::TransferSession transferSession;
bt_print::PrinterTransport printerTransport(Serial2);

}  // namespace

void setup() {
  Serial.begin(115200);
  delay(200);

  Serial.println("bt-print firmware booting");
  Serial.printf(
      "max-image-width=%u default-job=%ux%u printer-baud=%lu\n",
      bt_print::config::kMaxImageWidthPx,
      bt_print::config::kDefaultImageWidthPx,
      bt_print::config::kDefaultImageHeightPx,
      static_cast<unsigned long>(bt_print::config::kDefaultPrinterBaudRate));

  printerTransport.Begin(
      bt_print::config::kPrinterTxPin,
      bt_print::config::kPrinterRxPin,
      bt_print::config::kDefaultPrinterBaudRate);
  transferSession.Reset();
  bleService.Begin(transferSession, printerTransport);
}

void loop() {
  bleService.Poll();
  delay(10);
}

#endif

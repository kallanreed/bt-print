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

  Serial.println("printer: probing configured baud");
  printerTransport.Begin(
      bt_print::config::kPrinterTxPin,
      bt_print::config::kPrinterRxPin,
      bt_print::config::kDefaultPrinterBaudRate);
  Serial.println("printer-debug: before BEGIN line");
  printerTransport.PrintLine("BEGIN RASTER PROBE");
  Serial.println("printer-debug: after BEGIN line");
  Serial.println("printer-debug: before raster probe");
  printerTransport.PrintRasterProbe();
  Serial.println("printer-debug: after raster probe");
  Serial.println("printer-debug: settling before END line");
  delay(1000);
  Serial.println("printer-debug: before END line");
  printerTransport.PrintLine("END RASTER PROBE");
  Serial.println("printer-debug: after END line");
}

void loop() {
  //bleService.Poll(transferSession);
  //printerTransport.Poll();
  delay(50);
}

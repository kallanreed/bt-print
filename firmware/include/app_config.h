#pragma once

#include <stdint.h>

namespace bt_print::config {

constexpr uint16_t kMaxImageWidthPx = 384;
constexpr uint16_t kDefaultImageWidthPx = 384;
constexpr uint16_t kDefaultImageHeightPx = 384;
constexpr uint32_t kDefaultPrinterBaudRate = BT_PRINT_DEFAULT_PRINTER_BAUD;
constexpr char kBleDeviceName[] = "bt-print";
constexpr uint16_t kBleAppearance = 0x0000;
constexpr uint8_t kPrinterSerialPort = 2;
constexpr int8_t kPrinterTxPin = 17;        // GPIO17, UART2 TX
constexpr int8_t kPrinterRxPin = -1;

constexpr char kBleServiceUuid[] = "9f4d0001-8f5d-4f4c-8d3d-4f747072696e";
constexpr char kBleWriteCharacteristicUuid[] = "9f4d0002-8f5d-4f4c-8d3d-4f747072696e";
constexpr char kBleNotifyCharacteristicUuid[] = "9f4d0003-8f5d-4f4c-8d3d-4f747072696e";

}  // namespace bt_print::config

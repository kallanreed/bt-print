#pragma once

#include <stddef.h>
#include <stdint.h>

#include <NimBLEDevice.h>

#include "ble_protocol.h"
#include "transfer_session.h"

namespace bt_print {

class PrinterTransport;
class BleServerCallbacks;
class BleWriteCallbacks;

class BleService {
 public:
  void Begin(TransferSession& session, PrinterTransport& printerTransport);
  void Poll();

 private:
  friend class BleServerCallbacks;
  friend class BleWriteCallbacks;

  void HandleConnect();
  void HandleDisconnect();
  void HandleWrite(const uint8_t* data, size_t length);
  void NotifyAck(const PacketHeader& request) const;
  void NotifyError(const PacketHeader& request, ProtocolError error) const;
  void Notify(const uint8_t* data, size_t length) const;

  TransferSession* session_ = nullptr;
  PrinterTransport* printerTransport_ = nullptr;
  NimBLEServer* server_ = nullptr;
  NimBLEService* service_ = nullptr;
  NimBLECharacteristic* writeCharacteristic_ = nullptr;
  NimBLECharacteristic* notifyCharacteristic_ = nullptr;
  bool connected_ = false;
};

}  // namespace bt_print

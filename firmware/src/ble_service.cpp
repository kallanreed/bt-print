#include "ble_service.h"

#include <array>
#include <string>

#include <Arduino.h>
#include <NimBLEDevice.h>

#include "app_config.h"
#include "printer_transport.h"

namespace bt_print {

class BleServerCallbacks : public NimBLEServerCallbacks {
 public:
  explicit BleServerCallbacks(BleService& service) : service_(service) {}

  void onConnect(NimBLEServer*, NimBLEConnInfo&) override {
    service_.HandleConnect();
  }

  void onDisconnect(NimBLEServer*, NimBLEConnInfo&, int) override {
    service_.HandleDisconnect();
  }

 private:
  BleService& service_;
};

class BleWriteCallbacks : public NimBLECharacteristicCallbacks {
 public:
  explicit BleWriteCallbacks(BleService& service) : service_(service) {}

  void onWrite(NimBLECharacteristic* characteristic, NimBLEConnInfo&) override {
    const std::string value = characteristic->getValue();
    service_.HandleWrite(
        reinterpret_cast<const uint8_t*>(value.data()), value.size());
  }

 private:
  BleService& service_;
};

void BleService::Begin(
    TransferSession& session,
    PrinterTransport& printerTransport) {
  session_ = &session;
  printerTransport_ = &printerTransport;
  connected_ = false;

  NimBLEDevice::init(config::kBleDeviceName);
  NimBLEDevice::setMTU(247);

  server_ = NimBLEDevice::createServer();
  server_->setCallbacks(new BleServerCallbacks(*this));

  service_ = server_->createService(config::kBleServiceUuid);
  writeCharacteristic_ = service_->createCharacteristic(
      config::kBleWriteCharacteristicUuid,
      NIMBLE_PROPERTY::WRITE | NIMBLE_PROPERTY::WRITE_NR);
  writeCharacteristic_->setCallbacks(new BleWriteCallbacks(*this));
  notifyCharacteristic_ = service_->createCharacteristic(
      config::kBleNotifyCharacteristicUuid,
      NIMBLE_PROPERTY::NOTIFY);

  NimBLEAdvertising* advertising = NimBLEDevice::getAdvertising();
  advertising->setName(config::kBleDeviceName);
  advertising->addServiceUUID(config::kBleServiceUuid);
  advertising->setAppearance(config::kBleAppearance);
  advertising->enableScanResponse(true);
  advertising->start();

  Serial.printf(
      "ble: advertising name=%s service=%s write=%s notify=%s\n",
      config::kBleDeviceName,
      config::kBleServiceUuid,
      config::kBleWriteCharacteristicUuid,
      config::kBleNotifyCharacteristicUuid);
}

void BleService::Poll() {
  if (printerTransport_ != nullptr) {
    printerTransport_->Poll();
  }
}

void BleService::HandleConnect() {
  connected_ = true;
  Serial.printf("ble: client connected service=%s\n", config::kBleServiceUuid);
}

void BleService::HandleDisconnect() {
  connected_ = false;

  if (session_ != nullptr && session_->state() != TransferState::kIdle) {
    session_->Reset();
  }

  NimBLEDevice::startAdvertising();
  Serial.println("ble: client disconnected, advertising restarted");
}

void BleService::HandleWrite(const uint8_t* data, const size_t length) {
  if (session_ == nullptr || printerTransport_ == nullptr) {
    return;
  }

  PacketHeader request {};
  if (!ParsePacketHeader(data, length, request)) {
    Serial.println("ble: malformed packet header");
    NotifyError(request, ProtocolError::kMalformedPacket);
    return;
  }

  if (length != kPacketHeaderSize + request.payloadLength) {
    Serial.printf(
        "ble: payload mismatch type=%s payload=%u actual=%u\n",
        PacketTypeName(request.type),
        static_cast<unsigned>(request.payloadLength),
        static_cast<unsigned>(length - kPacketHeaderSize));
    NotifyError(request, ProtocolError::kPayloadLengthMismatch);
    return;
  }

  Serial.printf(
      "ble: packet type=%s transfer=%lu sequence=%u payload=%u\n",
      PacketTypeName(request.type),
      static_cast<unsigned long>(request.transferId),
      static_cast<unsigned>(request.sequence),
      static_cast<unsigned>(request.payloadLength));

  switch (request.type) {
    case PacketType::kTransferStart: {
      ImageEnvelope envelope {};
      if (request.payloadLength != kImageEnvelopeSize ||
          !ParseImageEnvelope(
              data + kPacketHeaderSize, request.payloadLength, envelope)) {
        NotifyError(request, ProtocolError::kInvalidEnvelope);
        return;
      }

      if (!session_->Start(request, envelope)) {
        NotifyError(request, session_->lastError());
        return;
      }

      NotifyAck(request);
      return;
    }

    case PacketType::kDataChunk:
      if (!session_->AppendChunk(
              request,
              data + kPacketHeaderSize,
              request.payloadLength)) {
        NotifyError(request, session_->lastError());
        return;
      }

      printerTransport_->PrintImage(
          data + kPacketHeaderSize,
          {
              session_->envelope().width,
              static_cast<uint16_t>(
                  request.payloadLength / session_->envelope().strideBytes),
              session_->envelope().strideBytes,
              request.payloadLength,
          },
          request.sequence == 1);
      NotifyAck(request);
      return;

    case PacketType::kTransferCommit:
      if (request.payloadLength != 0) {
        NotifyError(request, ProtocolError::kPayloadLengthMismatch);
        return;
      }

      if (!session_->Commit(request)) {
        NotifyError(request, session_->lastError());
        return;
      }

      printerTransport_->Feed();
      NotifyAck(request);
      session_->Reset();
      return;

    case PacketType::kReset:
      if (request.payloadLength != 0) {
        NotifyError(request, ProtocolError::kPayloadLengthMismatch);
        return;
      }

      session_->Reset();
      NotifyAck(request);
      return;

    case PacketType::kConfigure: {
      PrinterConfig config{};
      if (request.payloadLength != kPrinterConfigSize ||
          !ParsePrinterConfig(
              data + kPacketHeaderSize, request.payloadLength, config)) {
        NotifyError(request, ProtocolError::kPayloadLengthMismatch);
        return;
      }

      printerTransport_->Configure(config);
      NotifyAck(request);
      return;
    }

    case PacketType::kFeed: {
      if (request.payloadLength != 1) {
        NotifyError(request, ProtocolError::kPayloadLengthMismatch);
        return;
      }

      const uint8_t rows = data[kPacketHeaderSize];
      printerTransport_->FeedRows(rows);
      NotifyAck(request);
      return;
    }

    case PacketType::kAck:
    case PacketType::kError:
      NotifyError(request, ProtocolError::kInvalidPacketType);
      return;
  }

  NotifyError(request, ProtocolError::kInvalidPacketType);
}

void BleService::NotifyAck(const PacketHeader& request) const {
  if (session_ == nullptr) {
    return;
  }

  std::array<uint8_t, kAckPacketSize> packet {};
  const size_t packetLength = EncodeAckPacket(
      request,
      static_cast<uint8_t>(session_->state()),
      session_->nextSequence(),
      static_cast<uint32_t>(session_->bytesReceived()),
      packet.data(),
      packet.size());
  if (packetLength == 0) {
    return;
  }

  Notify(packet.data(), packetLength);
}

void BleService::NotifyError(
    const PacketHeader& request,
    const ProtocolError error) const {
  if (session_ == nullptr) {
    return;
  }

  std::array<uint8_t, kErrorPacketSize> packet {};
  const size_t packetLength = EncodeErrorPacket(
      request,
      error,
      session_->nextSequence(),
      static_cast<uint32_t>(session_->bytesReceived()),
      packet.data(),
      packet.size());
  if (packetLength == 0) {
    return;
  }

  Serial.printf(
      "ble: error type=%s code=%s expected-sequence=%u bytes=%lu\n",
      PacketTypeName(request.type),
      ProtocolErrorName(error),
      static_cast<unsigned>(session_->nextSequence()),
      static_cast<unsigned long>(session_->bytesReceived()));
  Notify(packet.data(), packetLength);
}

void BleService::Notify(const uint8_t* data, const size_t length) const {
  if (!connected_ || notifyCharacteristic_ == nullptr || data == nullptr ||
      length == 0) {
    return;
  }

  notifyCharacteristic_->setValue(data, length);
  notifyCharacteristic_->notify();
}

}  // namespace bt_print

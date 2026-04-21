#pragma once

#include <stddef.h>
#include <stdint.h>

#include "ble_protocol.h"

namespace bt_print {

enum class TransferState : uint8_t {
  kIdle,
  kReceiving,
  kReadyToPrint,
  kError,
};

class TransferSession {
 public:
  void Reset();
  bool Start(const PacketHeader& header, const ImageEnvelope& envelope);
  bool AppendChunk(const PacketHeader& header);
  bool Commit(const PacketHeader& header);

  TransferState state() const;
  const ImageEnvelope& envelope() const;
  size_t bytesReceived() const;
  uint32_t transferId() const;

 private:
  TransferState state_ = TransferState::kIdle;
  ImageEnvelope envelope_ {};
  size_t bytesReceived_ = 0;
  uint32_t transferId_ = 0;
  uint16_t nextSequence_ = 0;
};

}  // namespace bt_print

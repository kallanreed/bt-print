#include "transfer_session.h"

#include "app_config.h"

namespace bt_print {

void TransferSession::Reset() {
  state_ = TransferState::kIdle;
  envelope_ = {};
  bytesReceived_ = 0;
  transferId_ = 0;
  nextSequence_ = 0;
}

bool TransferSession::Start(
    const PacketHeader& header,
    const ImageEnvelope& envelope) {
  if (envelope.width == 0 || envelope.width > config::kMaxImageWidthPx ||
      envelope.payloadLength != CalculatePayloadLength(envelope.width, envelope.height) ||
      envelope.strideBytes != CalculateStrideBytes(envelope.width)) {
    state_ = TransferState::kError;
    return false;
  }

  state_ = TransferState::kReceiving;
  envelope_ = envelope;
  bytesReceived_ = 0;
  transferId_ = header.transferId;
  nextSequence_ = 0;
  return true;
}

bool TransferSession::AppendChunk(const PacketHeader& header) {
  if (state_ != TransferState::kReceiving || header.transferId != transferId_ ||
      header.sequence != nextSequence_) {
    state_ = TransferState::kError;
    return false;
  }

  bytesReceived_ += header.payloadLength;
  ++nextSequence_;

  if (bytesReceived_ > envelope_.payloadLength) {
    state_ = TransferState::kError;
    return false;
  }

  return true;
}

bool TransferSession::Commit(const PacketHeader& header) {
  if (state_ != TransferState::kReceiving || header.transferId != transferId_ ||
      bytesReceived_ != envelope_.payloadLength) {
    state_ = TransferState::kError;
    return false;
  }

  state_ = TransferState::kReadyToPrint;
  return true;
}

TransferState TransferSession::state() const {
  return state_;
}

const ImageEnvelope& TransferSession::envelope() const {
  return envelope_;
}

size_t TransferSession::bytesReceived() const {
  return bytesReceived_;
}

uint32_t TransferSession::transferId() const {
  return transferId_;
}

}  // namespace bt_print

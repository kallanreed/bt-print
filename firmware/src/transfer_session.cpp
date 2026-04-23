#include "transfer_session.h"

#include "app_config.h"

namespace bt_print {

void TransferSession::Reset() {
  state_ = TransferState::kIdle;
  envelope_ = {};
  bytesReceived_ = 0;
  transferId_ = 0;
  nextSequence_ = 0;
  lastError_ = ProtocolError::kNone;
}

bool TransferSession::Start(
    const PacketHeader& header,
    const ImageEnvelope& envelope) {
  if (state_ == TransferState::kReceiving ||
      state_ == TransferState::kReadyToPrint) {
    lastError_ = ProtocolError::kUnexpectedState;
    state_ = TransferState::kError;
    return false;
  }

  if (header.payloadLength != kImageEnvelopeSize || envelope.width == 0 ||
      envelope.height == 0 ||
      envelope.width > config::kMaxImageWidthPx ||
      envelope.payloadLength != CalculatePayloadLength(envelope.width, envelope.height) ||
      envelope.strideBytes != CalculateStrideBytes(envelope.width)) {
    lastError_ = ProtocolError::kInvalidEnvelope;
    state_ = TransferState::kError;
    return false;
  }

  state_ = TransferState::kReceiving;
  envelope_ = envelope;
  bytesReceived_ = 0;
  transferId_ = header.transferId;
  nextSequence_ = static_cast<uint16_t>(header.sequence + 1U);
  lastError_ = ProtocolError::kNone;
  return true;
}

bool TransferSession::AppendChunk(
    const PacketHeader& header,
    const uint8_t* payload,
    const size_t payloadLength) {
  if (state_ != TransferState::kReceiving) {
    lastError_ = ProtocolError::kUnexpectedState;
    state_ = TransferState::kError;
    return false;
  }

  if (header.transferId != transferId_) {
    lastError_ = ProtocolError::kUnexpectedTransfer;
    state_ = TransferState::kError;
    return false;
  }

  if (header.sequence != nextSequence_) {
    lastError_ = ProtocolError::kUnexpectedSequence;
    state_ = TransferState::kError;
    return false;
  }

  if (payloadLength != header.payloadLength ||
      payload == nullptr || payloadLength == 0 ||
      envelope_.strideBytes == 0 ||
      payloadLength % envelope_.strideBytes != 0) {
    lastError_ = ProtocolError::kPayloadLengthMismatch;
    state_ = TransferState::kError;
    return false;
  }

  if (bytesReceived_ + payloadLength > envelope_.payloadLength) {
    lastError_ = ProtocolError::kPayloadOverflow;
    state_ = TransferState::kError;
    return false;
  }

  bytesReceived_ += payloadLength;
  ++nextSequence_;

  if (bytesReceived_ > envelope_.payloadLength) {
    lastError_ = ProtocolError::kPayloadOverflow;
    state_ = TransferState::kError;
    return false;
  }

  lastError_ = ProtocolError::kNone;
  return true;
}

bool TransferSession::Commit(const PacketHeader& header) {
  if (state_ != TransferState::kReceiving) {
    lastError_ = ProtocolError::kUnexpectedState;
    state_ = TransferState::kError;
    return false;
  }

  if (header.transferId != transferId_) {
    lastError_ = ProtocolError::kUnexpectedTransfer;
    state_ = TransferState::kError;
    return false;
  }

  if (header.sequence != nextSequence_) {
    lastError_ = ProtocolError::kUnexpectedSequence;
    state_ = TransferState::kError;
    return false;
  }

  if (bytesReceived_ != envelope_.payloadLength) {
    lastError_ = ProtocolError::kTransferIncomplete;
    state_ = TransferState::kError;
    return false;
  }

  state_ = TransferState::kReadyToPrint;
  lastError_ = ProtocolError::kNone;
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

uint16_t TransferSession::nextSequence() const {
  return nextSequence_;
}

ProtocolError TransferSession::lastError() const {
  return lastError_;
}

}  // namespace bt_print

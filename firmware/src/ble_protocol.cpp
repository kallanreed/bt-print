#include "ble_protocol.h"

namespace bt_print {

namespace {

uint16_t ReadUint16Le(const uint8_t* data) {
  return static_cast<uint16_t>(data[0]) |
         (static_cast<uint16_t>(data[1]) << 8U);
}

uint32_t ReadUint32Le(const uint8_t* data) {
  return static_cast<uint32_t>(data[0]) |
         (static_cast<uint32_t>(data[1]) << 8U) |
         (static_cast<uint32_t>(data[2]) << 16U) |
         (static_cast<uint32_t>(data[3]) << 24U);
}

void WriteUint16Le(const uint16_t value, uint8_t* output) {
  output[0] = static_cast<uint8_t>(value & 0xFFU);
  output[1] = static_cast<uint8_t>((value >> 8U) & 0xFFU);
}

void WriteUint32Le(const uint32_t value, uint8_t* output) {
  output[0] = static_cast<uint8_t>(value & 0xFFU);
  output[1] = static_cast<uint8_t>((value >> 8U) & 0xFFU);
  output[2] = static_cast<uint8_t>((value >> 16U) & 0xFFU);
  output[3] = static_cast<uint8_t>((value >> 24U) & 0xFFU);
}

size_t EncodePacketHeader(
    const PacketHeader& header,
    uint8_t* output,
    const size_t capacity) {
  if (output == nullptr || capacity < kPacketHeaderSize) {
    return 0;
  }

  output[0] = static_cast<uint8_t>(header.type);
  WriteUint32Le(header.transferId, output + 1);
  WriteUint16Le(header.sequence, output + 5);
  WriteUint16Le(header.payloadLength, output + 7);
  return kPacketHeaderSize;
}

}  // namespace

bool IsControlPacket(const PacketType type) {
  return type == PacketType::kTransferStart ||
         type == PacketType::kTransferCommit ||
         type == PacketType::kReset ||
         type == PacketType::kConfigure ||
         type == PacketType::kAck ||
         type == PacketType::kError;
}

const char* PacketTypeName(const PacketType type) {
  switch (type) {
    case PacketType::kTransferStart:
      return "transfer-start";
    case PacketType::kDataChunk:
      return "data-chunk";
    case PacketType::kTransferCommit:
      return "transfer-commit";
    case PacketType::kReset:
      return "reset";
    case PacketType::kAck:
      return "ack";
    case PacketType::kError:
      return "error";
    case PacketType::kConfigure:
      return "configure";
  }

  return "unknown";
}

const char* ProtocolErrorName(const ProtocolError error) {
  switch (error) {
    case ProtocolError::kNone:
      return "none";
    case ProtocolError::kMalformedPacket:
      return "malformed-packet";
    case ProtocolError::kInvalidPacketType:
      return "invalid-packet-type";
    case ProtocolError::kInvalidEnvelope:
      return "invalid-envelope";
    case ProtocolError::kOutOfMemory:
      return "out-of-memory";
    case ProtocolError::kUnexpectedTransfer:
      return "unexpected-transfer";
    case ProtocolError::kUnexpectedSequence:
      return "unexpected-sequence";
    case ProtocolError::kUnexpectedState:
      return "unexpected-state";
    case ProtocolError::kPayloadLengthMismatch:
      return "payload-length-mismatch";
    case ProtocolError::kPayloadOverflow:
      return "payload-overflow";
    case ProtocolError::kTransferIncomplete:
      return "transfer-incomplete";
  }

  return "unknown";
}

bool ParsePacketHeader(
    const uint8_t* data,
    const size_t length,
    PacketHeader& header) {
  if (data == nullptr || length < kPacketHeaderSize) {
    return false;
  }

  header.type = static_cast<PacketType>(data[0]);
  header.transferId = ReadUint32Le(data + 1);
  header.sequence = ReadUint16Le(data + 5);
  header.payloadLength = ReadUint16Le(data + 7);
  return true;
}

bool ParseImageEnvelope(
    const uint8_t* data,
    const size_t length,
    ImageEnvelope& envelope) {
  if (data == nullptr || length < kImageEnvelopeSize) {
    return false;
  }

  envelope.width = ReadUint16Le(data);
  envelope.height = ReadUint16Le(data + 2);
  envelope.strideBytes = ReadUint16Le(data + 4);
  envelope.payloadLength = ReadUint32Le(data + 6);
  return true;
}

bool ParsePrinterConfig(
    const uint8_t* data,
    const size_t length,
    PrinterConfig& config) {
  if (data == nullptr || length < kPrinterConfigSize) {
    return false;
  }

  config.heatDots = data[0];
  config.heatTime = data[1];
  config.heatInterval = data[2];
  return true;
}

size_t EncodeAckPacket(
    const PacketHeader& request,
    const uint8_t transferState,
    const uint16_t nextSequence,
    const uint32_t bytesReceived,
    uint8_t* output,
    const size_t capacity) {
  if (output == nullptr || capacity < kAckPacketSize) {
    return 0;
  }

  const PacketHeader responseHeader = {
      PacketType::kAck, request.transferId, request.sequence, kAckPayloadSize};
  const size_t headerLength =
      EncodePacketHeader(responseHeader, output, capacity);
  if (headerLength == 0) {
    return 0;
  }

  output[headerLength] = static_cast<uint8_t>(request.type);
  output[headerLength + 1] = transferState;
  WriteUint16Le(nextSequence, output + headerLength + 2);
  WriteUint32Le(bytesReceived, output + headerLength + 4);
  return kAckPacketSize;
}

size_t EncodeErrorPacket(
    const PacketHeader& request,
    const ProtocolError error,
    const uint16_t expectedSequence,
    const uint32_t bytesReceived,
    uint8_t* output,
    const size_t capacity) {
  if (output == nullptr || capacity < kErrorPacketSize) {
    return 0;
  }

  const PacketHeader responseHeader = {
      PacketType::kError, request.transferId, request.sequence, kErrorPayloadSize};
  const size_t headerLength =
      EncodePacketHeader(responseHeader, output, capacity);
  if (headerLength == 0) {
    return 0;
  }

  output[headerLength] = static_cast<uint8_t>(error);
  output[headerLength + 1] = static_cast<uint8_t>(request.type);
  WriteUint16Le(expectedSequence, output + headerLength + 2);
  WriteUint32Le(bytesReceived, output + headerLength + 4);
  return kErrorPacketSize;
}

}  // namespace bt_print

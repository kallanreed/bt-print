#pragma once

#include <stddef.h>
#include <stdint.h>

namespace bt_print {

enum class PacketType : uint8_t {
  kTransferStart = 0x01,
  kDataChunk = 0x02,
  kTransferCommit = 0x03,
  kReset = 0x04,
  kAck = 0x05,
  kError = 0x06,
  kConfigure = 0x07,
};

enum class ProtocolError : uint8_t {
  kNone = 0x00,
  kMalformedPacket = 0x01,
  kInvalidPacketType = 0x02,
  kInvalidEnvelope = 0x03,
  kOutOfMemory = 0x04,
  kUnexpectedTransfer = 0x05,
  kUnexpectedSequence = 0x06,
  kUnexpectedState = 0x07,
  kPayloadLengthMismatch = 0x08,
  kPayloadOverflow = 0x09,
  kTransferIncomplete = 0x0A,
};

struct PacketHeader {
  PacketType type;
  uint32_t transferId;
  uint16_t sequence;
  uint16_t payloadLength;
};

struct ImageEnvelope {
  uint16_t width;
  uint16_t height;
  uint16_t strideBytes;
  uint32_t payloadLength;
};

struct AckPayload {
  PacketType packetType;
  uint8_t transferState;
  uint16_t nextSequence;
  uint32_t bytesReceived;
};

struct ErrorPayload {
  ProtocolError error;
  PacketType packetType;
  uint16_t expectedSequence;
  uint32_t bytesReceived;
};

struct PrinterConfig {
  uint8_t heatDots;
  uint8_t heatTime;
  uint8_t heatInterval;
};

constexpr size_t kPrinterConfigSize = 3;
constexpr size_t kPacketHeaderSize = 9;
constexpr size_t kImageEnvelopeSize = 10;
constexpr size_t kAckPayloadSize = 8;
constexpr size_t kErrorPayloadSize = 8;
constexpr size_t kAckPacketSize = kPacketHeaderSize + kAckPayloadSize;
constexpr size_t kErrorPacketSize = kPacketHeaderSize + kErrorPayloadSize;

constexpr uint16_t CalculateStrideBytes(const uint16_t width) {
  return static_cast<uint16_t>((width + 7U) / 8U);
}

constexpr uint32_t CalculatePayloadLength(
    const uint16_t width,
    const uint16_t height) {
  return static_cast<uint32_t>(CalculateStrideBytes(width)) * height;
}

bool IsControlPacket(PacketType type);
const char* PacketTypeName(PacketType type);
const char* ProtocolErrorName(ProtocolError error);

bool ParsePacketHeader(const uint8_t* data, size_t length, PacketHeader& header);
bool ParseImageEnvelope(const uint8_t* data, size_t length, ImageEnvelope& envelope);
bool ParsePrinterConfig(const uint8_t* data, size_t length, PrinterConfig& config);

size_t EncodeAckPacket(
    const PacketHeader& request,
    uint8_t transferState,
    uint16_t nextSequence,
    uint32_t bytesReceived,
    uint8_t* output,
    size_t capacity);
size_t EncodeErrorPacket(
    const PacketHeader& request,
    ProtocolError error,
    uint16_t expectedSequence,
    uint32_t bytesReceived,
    uint8_t* output,
    size_t capacity);

}  // namespace bt_print

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

}  // namespace bt_print

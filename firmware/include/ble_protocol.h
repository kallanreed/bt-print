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
  kFeed = 0x08,
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
  // Units: printer "max heating dots" setting; Adafruit_Thermal documents this
  // as 8-dot increments.
  // Default: printer default is documented as 7.
  // Purpose: controls how many dots can be heated at once; higher values print
  // faster but increase peak current draw.
  uint8_t heatDots;

  // Range: 3-255 printer-command value.
  // Units: 10 microseconds per increment.
  // Default: printer default is documented as 80.
  // Purpose: controls how long the print head applies heat for each fired dot.
  uint8_t heatTime;

  // Range: 0-255 printer-command value.
  // Units: 10 microseconds per increment.
  // Default: printer default is documented as 2.
  // Purpose: controls the cooling delay between heated dot groups.
  uint8_t heatInterval;

  // Range: 0-31 printer-manual value.
  // Units: density step, where output density is approximately 50% + 5% * value.
  // Default: not documented by the printer manual / library comments.
  // Purpose: adjusts overall print darkness / density.
  uint8_t density;

  // Range: 0-7 printer-manual value.
  // Units: 250 microseconds per increment.
  // Default: not documented by the printer manual / library comments.
  // Purpose: inserts extra pause between print bursts to trade speed for
  // stability and print quality.
  uint8_t breakTime;

  // Units: microseconds.
  // Default: 0 means auto-estimate from the other print profile inputs.
  // Purpose: host-side timing estimate passed to Adafruit_Thermal::setTimes()
  // for printed-dot rows. It affects pacing / completion timing, not printer
  // hardware configuration.
  uint16_t printSpeed;

  // Units: microseconds.
  // Default: 0 means auto-estimate from the other print profile inputs.
  // Purpose: host-side timing estimate passed to Adafruit_Thermal::setTimes()
  // for explicit feed rows / lines. It affects pacing / completion timing, not
  // printer hardware configuration.
  uint16_t feedSpeed;

  // Units: printer dot rows.
  // Default: 0.
  // Purpose: starts the paper motor before image heating begins to help spread
  // the current spike.
  uint8_t preFeedRows;
};

constexpr size_t kPrinterConfigSize = 10;
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

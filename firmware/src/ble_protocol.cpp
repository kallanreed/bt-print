#include "ble_protocol.h"

namespace bt_print {

bool IsControlPacket(const PacketType type) {
  return type == PacketType::kTransferStart ||
         type == PacketType::kTransferCommit ||
         type == PacketType::kReset ||
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
  }

  return "unknown";
}

}  // namespace bt_print

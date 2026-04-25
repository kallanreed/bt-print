#include <unity.h>

#include "ble_protocol.h"

using namespace bt_print;

// --- ParsePacketHeader ---

void test_parse_header_valid() {
  const uint8_t data[] = {
      0x01,                    // type = kTransferStart
      0x78, 0x56, 0x34, 0x12, // transferId = 0x12345678
      0x02, 0x00,              // sequence = 2
      0x0A, 0x00,              // payloadLength = 10
  };
  PacketHeader header{};
  TEST_ASSERT_TRUE(ParsePacketHeader(data, sizeof(data), header));
  TEST_ASSERT_EQUAL(PacketType::kTransferStart, header.type);
  TEST_ASSERT_EQUAL_UINT32(0x12345678, header.transferId);
  TEST_ASSERT_EQUAL_UINT16(2, header.sequence);
  TEST_ASSERT_EQUAL_UINT16(10, header.payloadLength);
}

void test_parse_header_null() {
  PacketHeader header{};
  TEST_ASSERT_FALSE(ParsePacketHeader(nullptr, 9, header));
}

void test_parse_header_too_short() {
  const uint8_t data[8] = {};
  PacketHeader header{};
  TEST_ASSERT_FALSE(ParsePacketHeader(data, sizeof(data), header));
}

// --- ParseImageEnvelope ---

void test_parse_envelope_valid() {
  const uint8_t data[] = {
      0x80, 0x01, // width = 384
      0x80, 0x01, // height = 384
      0x30, 0x00, // strideBytes = 48
      0x00, 0x48, 0x00, 0x00, // payloadLength = 18432
  };
  ImageEnvelope envelope{};
  TEST_ASSERT_TRUE(ParseImageEnvelope(data, sizeof(data), envelope));
  TEST_ASSERT_EQUAL_UINT16(384, envelope.width);
  TEST_ASSERT_EQUAL_UINT16(384, envelope.height);
  TEST_ASSERT_EQUAL_UINT16(48, envelope.strideBytes);
  TEST_ASSERT_EQUAL_UINT32(18432, envelope.payloadLength);
}

void test_parse_envelope_null() {
  ImageEnvelope envelope{};
  TEST_ASSERT_FALSE(ParseImageEnvelope(nullptr, 10, envelope));
}

void test_parse_envelope_too_short() {
  const uint8_t data[9] = {};
  ImageEnvelope envelope{};
  TEST_ASSERT_FALSE(ParseImageEnvelope(data, sizeof(data), envelope));
}

// --- CalculateStrideBytes / CalculatePayloadLength ---

void test_stride_bytes() {
  TEST_ASSERT_EQUAL_UINT16(48, CalculateStrideBytes(384));
  TEST_ASSERT_EQUAL_UINT16(1, CalculateStrideBytes(1));
  TEST_ASSERT_EQUAL_UINT16(1, CalculateStrideBytes(8));
  TEST_ASSERT_EQUAL_UINT16(2, CalculateStrideBytes(9));
}

void test_payload_length() {
  TEST_ASSERT_EQUAL_UINT32(18432, CalculatePayloadLength(384, 384));
  TEST_ASSERT_EQUAL_UINT32(48, CalculatePayloadLength(384, 1));
}

// --- EncodeAckPacket ---

void test_encode_ack_roundtrip() {
  const PacketHeader request = {PacketType::kTransferStart, 42, 0, 10};

  uint8_t buf[kAckPacketSize];
  const size_t len = EncodeAckPacket(request, 1, 1, 0, buf, sizeof(buf));
  TEST_ASSERT_EQUAL(kAckPacketSize, len);

  PacketHeader decoded{};
  TEST_ASSERT_TRUE(ParsePacketHeader(buf, len, decoded));
  TEST_ASSERT_EQUAL(PacketType::kAck, decoded.type);
  TEST_ASSERT_EQUAL_UINT32(42, decoded.transferId);
  TEST_ASSERT_EQUAL_UINT16(0, decoded.sequence);
  TEST_ASSERT_EQUAL_UINT16(kAckPayloadSize, decoded.payloadLength);
}

void test_encode_ack_null_output() {
  const PacketHeader request = {PacketType::kTransferStart, 1, 0, 10};
  TEST_ASSERT_EQUAL(0, EncodeAckPacket(request, 0, 0, 0, nullptr, 100));
}

void test_encode_ack_small_buffer() {
  const PacketHeader request = {PacketType::kTransferStart, 1, 0, 10};
  uint8_t buf[4];
  TEST_ASSERT_EQUAL(0, EncodeAckPacket(request, 0, 0, 0, buf, sizeof(buf)));
}

// --- EncodeErrorPacket ---

void test_encode_error_roundtrip() {
  const PacketHeader request = {PacketType::kDataChunk, 99, 3, 48};

  uint8_t buf[kErrorPacketSize];
  const size_t len = EncodeErrorPacket(
      request, ProtocolError::kPayloadOverflow, 2, 96, buf, sizeof(buf));
  TEST_ASSERT_EQUAL(kErrorPacketSize, len);

  PacketHeader decoded{};
  TEST_ASSERT_TRUE(ParsePacketHeader(buf, len, decoded));
  TEST_ASSERT_EQUAL(PacketType::kError, decoded.type);
  TEST_ASSERT_EQUAL_UINT32(99, decoded.transferId);
  TEST_ASSERT_EQUAL_UINT16(3, decoded.sequence);
  TEST_ASSERT_EQUAL_UINT16(kErrorPayloadSize, decoded.payloadLength);

  // Check error payload
  TEST_ASSERT_EQUAL(static_cast<uint8_t>(ProtocolError::kPayloadOverflow),
                    buf[kPacketHeaderSize]);
  TEST_ASSERT_EQUAL(static_cast<uint8_t>(PacketType::kDataChunk),
                    buf[kPacketHeaderSize + 1]);
}

void test_encode_error_null_output() {
  const PacketHeader request = {PacketType::kDataChunk, 1, 0, 0};
  TEST_ASSERT_EQUAL(
      0, EncodeErrorPacket(request, ProtocolError::kNone, 0, 0, nullptr, 100));
}

// --- IsControlPacket ---

void test_is_control_packet() {
  TEST_ASSERT_TRUE(IsControlPacket(PacketType::kTransferStart));
  TEST_ASSERT_TRUE(IsControlPacket(PacketType::kTransferCommit));
  TEST_ASSERT_TRUE(IsControlPacket(PacketType::kReset));
  TEST_ASSERT_TRUE(IsControlPacket(PacketType::kAck));
  TEST_ASSERT_TRUE(IsControlPacket(PacketType::kError));
  TEST_ASSERT_TRUE(IsControlPacket(PacketType::kConfigure));
  TEST_ASSERT_FALSE(IsControlPacket(PacketType::kDataChunk));
}

// --- ParsePrinterConfig ---

void test_parse_config_valid() {
  const uint8_t data[] = {7, 120, 120, 12, 4, 0x30, 0x75, 0x34, 0x08, 1};
  PrinterConfig config{};
  TEST_ASSERT_TRUE(ParsePrinterConfig(data, sizeof(data), config));
  TEST_ASSERT_EQUAL_UINT8(7, config.heatDots);
  TEST_ASSERT_EQUAL_UINT8(120, config.heatTime);
  TEST_ASSERT_EQUAL_UINT8(120, config.heatInterval);
  TEST_ASSERT_EQUAL_UINT8(12, config.density);
  TEST_ASSERT_EQUAL_UINT8(4, config.breakTime);
  TEST_ASSERT_EQUAL_UINT16(30000, config.printSpeed);
  TEST_ASSERT_EQUAL_UINT16(2100, config.feedSpeed);
  TEST_ASSERT_EQUAL_UINT8(1, config.preFeedRows);
}

void test_parse_config_null() {
  PrinterConfig config{};
  TEST_ASSERT_FALSE(ParsePrinterConfig(nullptr, kPrinterConfigSize, config));
}

void test_parse_config_too_short() {
  const uint8_t data[kPrinterConfigSize - 1] = {};
  PrinterConfig config{};
  TEST_ASSERT_FALSE(ParsePrinterConfig(data, sizeof(data), config));
}

// --- PacketTypeName / ProtocolErrorName ---

void test_packet_type_name() {
  TEST_ASSERT_EQUAL_STRING("transfer-start",
                           PacketTypeName(PacketType::kTransferStart));
  TEST_ASSERT_EQUAL_STRING("data-chunk",
                           PacketTypeName(PacketType::kDataChunk));
  TEST_ASSERT_EQUAL_STRING("unknown",
                           PacketTypeName(static_cast<PacketType>(0xFF)));
}

void test_protocol_error_name() {
  TEST_ASSERT_EQUAL_STRING("none", ProtocolErrorName(ProtocolError::kNone));
  TEST_ASSERT_EQUAL_STRING("payload-overflow",
                           ProtocolErrorName(ProtocolError::kPayloadOverflow));
  TEST_ASSERT_EQUAL_STRING(
      "unknown", ProtocolErrorName(static_cast<ProtocolError>(0xFF)));
}

void run_tests() {
  UNITY_BEGIN();

  RUN_TEST(test_parse_header_valid);
  RUN_TEST(test_parse_header_null);
  RUN_TEST(test_parse_header_too_short);
  RUN_TEST(test_parse_envelope_valid);
  RUN_TEST(test_parse_envelope_null);
  RUN_TEST(test_parse_envelope_too_short);
  RUN_TEST(test_stride_bytes);
  RUN_TEST(test_payload_length);
  RUN_TEST(test_encode_ack_roundtrip);
  RUN_TEST(test_encode_ack_null_output);
  RUN_TEST(test_encode_ack_small_buffer);
  RUN_TEST(test_encode_error_roundtrip);
  RUN_TEST(test_encode_error_null_output);
  RUN_TEST(test_is_control_packet);
  RUN_TEST(test_parse_config_valid);
  RUN_TEST(test_parse_config_null);
  RUN_TEST(test_parse_config_too_short);
  RUN_TEST(test_packet_type_name);
  RUN_TEST(test_protocol_error_name);

  UNITY_END();
}

#ifdef ARDUINO
void setup() {
  run_tests();
}

void loop() {}
#else
int main() {
  run_tests();
  return 0;
}
#endif

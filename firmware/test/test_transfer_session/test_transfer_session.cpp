#include <unity.h>

#include "transfer_session.h"

using namespace bt_print;

namespace {

// A simple 8x2 image: width=8, height=2, stride=1, payload=2.
constexpr uint16_t kWidth = 8;
constexpr uint16_t kHeight = 2;
constexpr uint16_t kStride = 1;
constexpr uint32_t kPayloadLen = 2;

ImageEnvelope ValidEnvelope() {
  return {kWidth, kHeight, kStride, kPayloadLen};
}

PacketHeader StartHeader(uint32_t transferId = 1, uint16_t sequence = 0) {
  return {PacketType::kTransferStart, transferId, sequence, kImageEnvelopeSize};
}

PacketHeader ChunkHeader(uint32_t transferId = 1,
                          uint16_t sequence = 1,
                          uint16_t payloadLength = kStride) {
  return {PacketType::kDataChunk, transferId, sequence, payloadLength};
}

PacketHeader CommitHeader(uint32_t transferId = 1, uint16_t sequence = 3) {
  return {PacketType::kTransferCommit, transferId, sequence, 0};
}

}  // namespace

// --- Reset ---

void test_reset_returns_to_idle() {
  TransferSession session;
  session.Reset();
  TEST_ASSERT_EQUAL(TransferState::kIdle, session.state());
  TEST_ASSERT_EQUAL(ProtocolError::kNone, session.lastError());
  TEST_ASSERT_EQUAL(0, session.bytesReceived());
}

// --- Start ---

void test_start_valid() {
  TransferSession session;
  session.Reset();
  TEST_ASSERT_TRUE(session.Start(StartHeader(), ValidEnvelope()));
  TEST_ASSERT_EQUAL(TransferState::kReceiving, session.state());
  TEST_ASSERT_EQUAL_UINT16(1, session.nextSequence());
  TEST_ASSERT_EQUAL_UINT32(1, session.transferId());
}

void test_start_zero_width() {
  TransferSession session;
  session.Reset();
  ImageEnvelope env = ValidEnvelope();
  env.width = 0;
  TEST_ASSERT_FALSE(session.Start(StartHeader(), env));
  TEST_ASSERT_EQUAL(TransferState::kError, session.state());
  TEST_ASSERT_EQUAL(ProtocolError::kInvalidEnvelope, session.lastError());
}

void test_start_zero_height() {
  TransferSession session;
  session.Reset();
  ImageEnvelope env = ValidEnvelope();
  env.height = 0;
  TEST_ASSERT_FALSE(session.Start(StartHeader(), env));
  TEST_ASSERT_EQUAL(ProtocolError::kInvalidEnvelope, session.lastError());
}

void test_start_width_exceeds_max() {
  TransferSession session;
  session.Reset();
  ImageEnvelope env = {385, 1, CalculateStrideBytes(385),
                       CalculatePayloadLength(385, 1)};
  TEST_ASSERT_FALSE(session.Start(StartHeader(), env));
  TEST_ASSERT_EQUAL(ProtocolError::kInvalidEnvelope, session.lastError());
}

void test_start_wrong_payload_length() {
  TransferSession session;
  session.Reset();
  ImageEnvelope env = ValidEnvelope();
  env.payloadLength = 999;
  TEST_ASSERT_FALSE(session.Start(StartHeader(), env));
  TEST_ASSERT_EQUAL(ProtocolError::kInvalidEnvelope, session.lastError());
}

void test_start_wrong_stride() {
  TransferSession session;
  session.Reset();
  ImageEnvelope env = ValidEnvelope();
  env.strideBytes = 99;
  TEST_ASSERT_FALSE(session.Start(StartHeader(), env));
  TEST_ASSERT_EQUAL(ProtocolError::kInvalidEnvelope, session.lastError());
}

void test_start_wrong_header_payload_length() {
  TransferSession session;
  session.Reset();
  PacketHeader hdr = StartHeader();
  hdr.payloadLength = 5; // not kImageEnvelopeSize
  TEST_ASSERT_FALSE(session.Start(hdr, ValidEnvelope()));
  TEST_ASSERT_EQUAL(ProtocolError::kInvalidEnvelope, session.lastError());
}

void test_start_while_receiving_fails() {
  TransferSession session;
  session.Reset();
  session.Start(StartHeader(), ValidEnvelope());
  TEST_ASSERT_FALSE(session.Start(StartHeader(2), ValidEnvelope()));
  TEST_ASSERT_EQUAL(TransferState::kError, session.state());
  TEST_ASSERT_EQUAL(ProtocolError::kUnexpectedState, session.lastError());
}

// --- AppendChunk ---

void test_append_chunk_valid() {
  TransferSession session;
  session.Reset();
  session.Start(StartHeader(), ValidEnvelope());

  const uint8_t data[kStride] = {0xFF};
  TEST_ASSERT_TRUE(
      session.AppendChunk(ChunkHeader(1, 1, kStride), data, kStride));
  TEST_ASSERT_EQUAL(kStride, session.bytesReceived());
  TEST_ASSERT_EQUAL_UINT16(2, session.nextSequence());
}

void test_append_chunk_wrong_transfer_id() {
  TransferSession session;
  session.Reset();
  session.Start(StartHeader(1), ValidEnvelope());

  const uint8_t data[kStride] = {0xFF};
  TEST_ASSERT_FALSE(
      session.AppendChunk(ChunkHeader(99, 1, kStride), data, kStride));
  TEST_ASSERT_EQUAL(ProtocolError::kUnexpectedTransfer, session.lastError());
}

void test_append_chunk_wrong_sequence() {
  TransferSession session;
  session.Reset();
  session.Start(StartHeader(), ValidEnvelope());

  const uint8_t data[kStride] = {0xFF};
  TEST_ASSERT_FALSE(
      session.AppendChunk(ChunkHeader(1, 5, kStride), data, kStride));
  TEST_ASSERT_EQUAL(ProtocolError::kUnexpectedSequence, session.lastError());
}

void test_append_chunk_not_receiving() {
  TransferSession session;
  session.Reset();

  const uint8_t data[kStride] = {0xFF};
  TEST_ASSERT_FALSE(
      session.AppendChunk(ChunkHeader(1, 0, kStride), data, kStride));
  TEST_ASSERT_EQUAL(ProtocolError::kUnexpectedState, session.lastError());
}

void test_append_chunk_null_payload() {
  TransferSession session;
  session.Reset();
  session.Start(StartHeader(), ValidEnvelope());

  TEST_ASSERT_FALSE(
      session.AppendChunk(ChunkHeader(1, 1, kStride), nullptr, kStride));
  TEST_ASSERT_EQUAL(ProtocolError::kPayloadLengthMismatch,
                    session.lastError());
}

void test_append_chunk_misaligned_stride() {
  TransferSession session;
  session.Reset();
  session.Start(StartHeader(), ValidEnvelope());

  // Send 3 bytes when stride is 1 — valid modulo, but let's send a
  // size that doesn't divide evenly into stride for a wider image.
  // Use a 16px wide image (stride=2) and send 3 bytes.
  ImageEnvelope env = {16, 2, 2, 4};
  TransferSession session2;
  session2.Reset();
  session2.Start(StartHeader(2), env);

  const uint8_t data[3] = {0xFF, 0xFF, 0xFF};
  TEST_ASSERT_FALSE(
      session2.AppendChunk(ChunkHeader(2, 1, 3), data, 3));
  TEST_ASSERT_EQUAL(ProtocolError::kPayloadLengthMismatch,
                    session2.lastError());
}

void test_append_chunk_overflow() {
  TransferSession session;
  session.Reset();
  session.Start(StartHeader(), ValidEnvelope());

  // Image is 2 bytes total. Send 1 byte twice, then a third should overflow.
  const uint8_t data[kStride] = {0xFF};
  session.AppendChunk(ChunkHeader(1, 1, kStride), data, kStride);
  session.AppendChunk(ChunkHeader(1, 2, kStride), data, kStride);
  TEST_ASSERT_FALSE(
      session.AppendChunk(ChunkHeader(1, 3, kStride), data, kStride));
  TEST_ASSERT_EQUAL(ProtocolError::kPayloadOverflow, session.lastError());
}

// --- Commit ---

void test_commit_valid() {
  TransferSession session;
  session.Reset();
  session.Start(StartHeader(), ValidEnvelope());

  const uint8_t data[kStride] = {0xFF};
  session.AppendChunk(ChunkHeader(1, 1, kStride), data, kStride);
  session.AppendChunk(ChunkHeader(1, 2, kStride), data, kStride);

  TEST_ASSERT_TRUE(session.Commit(CommitHeader(1, 3)));
  TEST_ASSERT_EQUAL(TransferState::kReadyToPrint, session.state());
}

void test_commit_incomplete_transfer() {
  TransferSession session;
  session.Reset();
  session.Start(StartHeader(), ValidEnvelope());

  // Only sent 1 of 2 bytes.
  const uint8_t data[kStride] = {0xFF};
  session.AppendChunk(ChunkHeader(1, 1, kStride), data, kStride);

  TEST_ASSERT_FALSE(session.Commit(CommitHeader(1, 2)));
  TEST_ASSERT_EQUAL(ProtocolError::kTransferIncomplete, session.lastError());
}

void test_commit_wrong_transfer_id() {
  TransferSession session;
  session.Reset();
  session.Start(StartHeader(1), ValidEnvelope());

  const uint8_t data[kStride] = {0xFF};
  session.AppendChunk(ChunkHeader(1, 1, kStride), data, kStride);
  session.AppendChunk(ChunkHeader(1, 2, kStride), data, kStride);

  TEST_ASSERT_FALSE(session.Commit(CommitHeader(99, 3)));
  TEST_ASSERT_EQUAL(ProtocolError::kUnexpectedTransfer, session.lastError());
}

void test_commit_wrong_sequence() {
  TransferSession session;
  session.Reset();
  session.Start(StartHeader(), ValidEnvelope());

  const uint8_t data[kStride] = {0xFF};
  session.AppendChunk(ChunkHeader(1, 1, kStride), data, kStride);
  session.AppendChunk(ChunkHeader(1, 2, kStride), data, kStride);

  TEST_ASSERT_FALSE(session.Commit(CommitHeader(1, 99)));
  TEST_ASSERT_EQUAL(ProtocolError::kUnexpectedSequence, session.lastError());
}

void test_commit_not_receiving() {
  TransferSession session;
  session.Reset();
  TEST_ASSERT_FALSE(session.Commit(CommitHeader(1, 0)));
  TEST_ASSERT_EQUAL(ProtocolError::kUnexpectedState, session.lastError());
}

// --- Full transfer lifecycle ---

void test_full_transfer_then_reset() {
  TransferSession session;
  session.Reset();

  TEST_ASSERT_TRUE(session.Start(StartHeader(10, 0), ValidEnvelope()));
  TEST_ASSERT_EQUAL(TransferState::kReceiving, session.state());

  const uint8_t row[kStride] = {0xAA};
  TEST_ASSERT_TRUE(session.AppendChunk(ChunkHeader(10, 1, kStride), row, kStride));
  TEST_ASSERT_TRUE(session.AppendChunk(ChunkHeader(10, 2, kStride), row, kStride));
  TEST_ASSERT_EQUAL(kPayloadLen, session.bytesReceived());

  TEST_ASSERT_TRUE(session.Commit(CommitHeader(10, 3)));
  TEST_ASSERT_EQUAL(TransferState::kReadyToPrint, session.state());

  session.Reset();
  TEST_ASSERT_EQUAL(TransferState::kIdle, session.state());
  TEST_ASSERT_EQUAL(0, session.bytesReceived());
}

int main() {
  UNITY_BEGIN();

  RUN_TEST(test_reset_returns_to_idle);
  RUN_TEST(test_start_valid);
  RUN_TEST(test_start_zero_width);
  RUN_TEST(test_start_zero_height);
  RUN_TEST(test_start_width_exceeds_max);
  RUN_TEST(test_start_wrong_payload_length);
  RUN_TEST(test_start_wrong_stride);
  RUN_TEST(test_start_wrong_header_payload_length);
  RUN_TEST(test_start_while_receiving_fails);
  RUN_TEST(test_append_chunk_valid);
  RUN_TEST(test_append_chunk_wrong_transfer_id);
  RUN_TEST(test_append_chunk_wrong_sequence);
  RUN_TEST(test_append_chunk_not_receiving);
  RUN_TEST(test_append_chunk_null_payload);
  RUN_TEST(test_append_chunk_misaligned_stride);
  RUN_TEST(test_append_chunk_overflow);
  RUN_TEST(test_commit_valid);
  RUN_TEST(test_commit_incomplete_transfer);
  RUN_TEST(test_commit_wrong_transfer_id);
  RUN_TEST(test_commit_wrong_sequence);
  RUN_TEST(test_commit_not_receiving);
  RUN_TEST(test_full_transfer_then_reset);

  return UNITY_END();
}

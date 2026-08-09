import {
  decodeRtcBinaryResourceChunk,
  encodeRtcLogicalMessage,
  RTC_BINARY_RESOURCE_HEADER_BYTES,
  RTC_MAX_FRAME_BYTES,
  RTC_MAX_MESSAGE_BYTES,
  RtcChunkReassembler,
} from "./datachannel-framing"

describe("RTC DataChannel framing", () => {
  it("keeps small messages as one frame", () => {
    expect(encodeRtcLogicalMessage('{"ok":true}', "m1")).toEqual(['{"ok":true}'])
  })

  it("reassembles a large message in order and bounds each frame", () => {
    const message = JSON.stringify({ value: "x".repeat(100_000) })
    const frames = encodeRtcLogicalMessage(message, "m1")
    expect(frames.length).toBeGreaterThan(2)
    expect(
      frames.every((frame) => new TextEncoder().encode(frame).byteLength <= RTC_MAX_FRAME_BYTES)
    ).toBe(true)

    const reassembler = new RtcChunkReassembler()
    let completed: ReturnType<RtcChunkReassembler["accept"]> | undefined
    for (const frame of frames) {
      const result = reassembler.accept(frame)
      if (result.kind === "message") completed = result
    }
    expect(completed?.kind).toBe("message")
    if (completed?.kind === "message") expect(reassembler.decode(completed)).toBe(message)
  })

  it("rejects oversized logical messages and bounded reassembly overflow", () => {
    expect(() => encodeRtcLogicalMessage("x".repeat(RTC_MAX_MESSAGE_BYTES + 1), "huge")).toThrow(
      "rtc_message_too_large"
    )
    const reassembler = new RtcChunkReassembler()
    for (let index = 0; index < 8; index++) {
      expect(
        reassembler.accept(
          JSON.stringify({
            kind: "chunk/start",
            messageId: `m${index}`,
            totalBytes: 512 * 1024,
            totalChunks: 22,
          })
        )
      ).toEqual({ kind: "partial" })
    }
    expect(
      reassembler.accept(
        JSON.stringify({
          kind: "chunk/start",
          messageId: "overflow",
          totalBytes: 1,
          totalChunks: 1,
        })
      )
    ).toEqual({ kind: "cancel", messageId: "overflow", reason: "reassembly_overflow" })
  })

  it("rejects invalid chunk indexes and expired streams", () => {
    const reassembler = new RtcChunkReassembler()
    reassembler.accept(
      JSON.stringify({ kind: "chunk/start", messageId: "m1", totalBytes: 4, totalChunks: 1 }),
      0
    )
    expect(
      reassembler.accept(
        JSON.stringify({ kind: "chunk/data", messageId: "m1", index: 2, data: "eA" }),
        1
      )
    ).toEqual({ kind: "cancel", messageId: "m1", reason: "invalid_chunk" })
    expect(
      reassembler.accept(
        JSON.stringify({ kind: "chunk/data", messageId: "m1", index: 0, data: "eA" }),
        20_000
      )
    ).toEqual({ kind: "cancel", messageId: "m1", reason: "invalid_chunk" })
  })

  it("decodes raw binary resource frames without base64 expansion", () => {
    const requestId = "550e8400-e29b-41d4-a716-446655440000"
    const payload = Uint8Array.from([0, 255, 17, 99])
    const frame = new ArrayBuffer(RTC_BINARY_RESOURCE_HEADER_BYTES + payload.byteLength)
    const bytes = new Uint8Array(frame)
    bytes.set([0x43, 0x47, 0x4d, 0x31], 0)
    bytes.set(new TextEncoder().encode(requestId), 4)
    const view = new DataView(frame)
    view.setUint32(40, 1)
    view.setUint32(44, 3)
    bytes.set(payload, RTC_BINARY_RESOURCE_HEADER_BYTES)

    expect(decodeRtcBinaryResourceChunk(frame)).toEqual({
      requestId,
      index: 1,
      totalChunks: 3,
      bytes: payload,
    })
  })
})

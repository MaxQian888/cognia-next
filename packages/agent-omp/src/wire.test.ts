import {
  OmpChunkDecoder,
  encodeOmpFrame,
  OMP_MAX_FRAME_BYTES,
  OMP_MAX_REASSEMBLED_BYTES,
} from "./wire"

function chunks(frame: unknown) {
  const bytes = Buffer.from(JSON.stringify(frame))
  const size = 256 * 1024
  return Array.from({ length: Math.ceil(bytes.length / size) }, (_, index) => ({
    type: "rpc_chunk",
    chunkId: "large",
    index,
    count: Math.ceil(bytes.length / size),
    byteLength: bytes.length,
    data: bytes.subarray(index * size, (index + 1) * size).toString("base64"),
  }))
}

test("losslessly reconstructs large UTF-8 logical frames", () => {
  const expected = { type: "command_output", text: "汉字🙂".repeat(140_000) }
  const decoder = new OmpChunkDecoder()
  const frames = chunks(expected)
  frames.slice(0, -1).forEach((frame) => expect(decoder.push(frame)).toBeUndefined())
  expect(decoder.push(frames.at(-1))).toEqual(expected)
  expect(decoder.incomplete).toBe(false)
})

test("rejects interleaved and interrupted sequences and releases buffered bytes", () => {
  const frame = chunks({ type: "command_output", text: "x".repeat(OMP_MAX_FRAME_BYTES) })[0]
  for (const invalid of [
    { ...frame, chunkId: "other", index: 1 },
    { type: "agent_start" },
    { ...frame, index: 0 },
  ]) {
    const decoder = new OmpChunkDecoder()
    decoder.push(frame)
    expect(() => decoder.push(invalid)).toThrow()
    expect(decoder.incomplete).toBe(false)
  }
})

test("enforces bounded metadata and canonical base64", () => {
  const frame = chunks({ type: "command_output", text: "x".repeat(OMP_MAX_FRAME_BYTES) })[0]
  for (const patch of [
    { count: 1 },
    { count: 257 },
    { count: 1.5 },
    { index: 1 },
    { chunkId: "" },
    { byteLength: OMP_MAX_REASSEMBLED_BYTES + 1 },
    { byteLength: 100 },
    { data: "!!==" },
    { data: "Zh==" },
    { data: "" },
  ])
    expect(() => new OmpChunkDecoder().push({ ...frame, ...patch })).toThrow()
  expect(() => new OmpChunkDecoder(OMP_MAX_FRAME_BYTES).push(frame)).toThrow()
})

test("checks final declared byte length and strict UTF-8", () => {
  const frames = chunks({ type: "command_output", text: "x".repeat(OMP_MAX_FRAME_BYTES) })
  const decoder = new OmpChunkDecoder()
  frames.slice(0, -1).forEach((frame) => decoder.push(frame))
  expect(() =>
    decoder.push({ ...frames.at(-1), data: Buffer.from("x").toString("base64") })
  ).toThrow(/length/)
  const invalid = Array.from({ length: 4 }, (_, index) => ({
    type: "rpc_chunk",
    chunkId: "utf8",
    index,
    count: 4,
    byteLength: OMP_MAX_FRAME_BYTES,
    data: Buffer.alloc(256 * 1024, 0xff).toString("base64"),
  }))
  const strict = new OmpChunkDecoder()
  invalid.slice(0, -1).forEach((frame) => strict.push(frame))
  expect(() => strict.push(invalid[3])).toThrow()
})

test("outbound input uses one LF frame with newline included in its byte budget", () => {
  const frame = { type: "prompt" as const, message: "🙂\nhello" }
  const line = encodeOmpFrame(frame)
  expect(JSON.parse(line)).toEqual(frame)
  const bytes = Buffer.byteLength(line)
  expect(encodeOmpFrame(frame, bytes)).toBe(line)
  expect(() => encodeOmpFrame(frame, bytes - 1)).toThrow()
})

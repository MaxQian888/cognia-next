import {
  decodeTerminalFrame,
  EMPTY_SESSION_ID,
  encodeTerminalFrame,
  makeTerminalJsonFrame,
  makeTerminalFrame,
  splitTerminalStreamFrames,
  TerminalFrameFlag,
  TerminalFrameKind,
  TERMINAL_FRAME_HEADER_BYTES,
  TERMINAL_MAX_FRAME_PAYLOAD,
} from "./protocol"
import fixtures from "@/protocol/terminal-fixtures.json"

describe("terminal protocol", () => {
  it("matches the Rust header layout and round-trips UUID/sequence", () => {
    const frame = makeTerminalFrame(TerminalFrameKind.Stdout, {
      sessionId: "00112233-4455-6677-8899-aabbccddeeff",
      sequence: BigInt("0x0102030405060708"),
      flags: TerminalFrameFlag.AckRequired,
      payload: new TextEncoder().encode("hello"),
    })
    const encoded = encodeTerminalFrame(frame)
    expect(new TextDecoder().decode(encoded.slice(0, 4))).toBe("CGTH")
    expect(encoded).toHaveLength(TERMINAL_FRAME_HEADER_BYTES + 5)
    expect(decodeTerminalFrame(encoded)).toEqual(frame)
  })

  it("matches the shared Rust/TypeScript protocol fixture byte-for-byte", () => {
    const fixture = fixtures.stdoutHello
    const encoded = encodeTerminalFrame(
      makeTerminalFrame(fixture.kind as TerminalFrameKind, {
        sessionId: fixture.sessionId,
        sequence: BigInt(fixture.sequence),
        flags: fixture.flags,
        payload: new TextEncoder().encode(fixture.payloadUtf8),
      })
    )
    expect(Array.from(encoded, (byte) => byte.toString(16).padStart(2, "0")).join("")).toBe(
      fixture.encodedHex
    )
  })

  it("rejects bad magic and truncated payloads", () => {
    const encoded = encodeTerminalFrame(makeTerminalFrame(TerminalFrameKind.List))
    encoded[0] = 0
    expect(() => decodeTerminalFrame(encoded)).toThrow("magic")
    const valid = encodeTerminalFrame(makeTerminalFrame(TerminalFrameKind.List))
    expect(() => decodeTerminalFrame(valid.slice(0, -1))).toThrow("truncated")
  })

  it("splits stream payloads into bounded ordered frames", () => {
    const payload = new Uint8Array(TERMINAL_MAX_FRAME_PAYLOAD * 2 + 7)
    const frames = splitTerminalStreamFrames(
      TerminalFrameKind.Stdin,
      EMPTY_SESSION_ID,
      BigInt(9),
      payload
    )
    expect(frames.map((frame) => frame.payload.byteLength)).toEqual([
      TERMINAL_MAX_FRAME_PAYLOAD,
      TERMINAL_MAX_FRAME_PAYLOAD,
      7,
    ])
    expect(frames.at(-1)?.flags).toBe(TerminalFrameFlag.EndOfMessage)
  })

  it("builds JSON command frames through the shared encoder", () => {
    const frame = makeTerminalJsonFrame(TerminalFrameKind.Spawn, { shell: "/bin/zsh" })
    expect(JSON.parse(new TextDecoder().decode(frame.payload))).toEqual({ shell: "/bin/zsh" })
  })
})

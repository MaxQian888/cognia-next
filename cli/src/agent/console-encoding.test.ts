/**
 * @jest-environment node
 */
import {
  consoleDecoderLabel,
  decodeConsoleBytes,
  __resetConsoleDecoderCache,
} from "./console-encoding"

describe("console-encoding", () => {
  afterEach(() => __resetConsoleDecoderCache())

  it("round-trips valid UTF-8 (incl. non-ASCII) unchanged", () => {
    const buf = Buffer.from("héllo 中文 🎉", "utf8")
    expect(decodeConsoleBytes(buf)).toBe("héllo 中文 🎉")
  })

  it("never throws on invalid UTF-8 bytes — falls back to the console code page", () => {
    // 0xD6 0xD0 0xCE 0xC4 = 中文 in GBK; invalid as UTF-8.
    const gbk = Buffer.from([0xd6, 0xd0, 0xce, 0xc4])
    const out = decodeConsoleBytes(gbk)
    expect(typeof out).toBe("string")
    expect(out.length).toBeGreaterThan(0)
    // On a GBK console (Chinese Windows) the fallback decodes it correctly.
    if (consoleDecoderLabel() === "gbk") expect(out).toBe("中文")
  })

  it("resolves a non-empty decoder label (utf-8 off Windows)", () => {
    const label = consoleDecoderLabel()
    expect(typeof label).toBe("string")
    expect(label.length).toBeGreaterThan(0)
    if (process.platform !== "win32") expect(label).toBe("utf-8")
  })

  it("caches the detected label across calls", () => {
    expect(consoleDecoderLabel()).toBe(consoleDecoderLabel())
  })
})

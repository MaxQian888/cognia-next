/**
 * @jest-environment node
 */
import { resolveImageRef } from "./image"

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]).buffer

describe("resolveImageRef", () => {
  it("emits a native image block for Anthropic (always vision-capable)", async () => {
    const r = await resolveImageRef("a.png", "/w", {
      isAnthropic: true,
      provider: "anthropic",
      model: "claude-opus-4-5",
      encodeImageBlock: () => ({
        type: "image",
        source: { type: "base64", media_type: "image/png", data: "IMG" },
      }),
    })
    expect(r).toEqual({
      kind: "block",
      block: { type: "image", source: { type: "base64", media_type: "image/png", data: "IMG" } },
    })
  })

  it("emits a native block for a non-Anthropic vision model", async () => {
    const r = await resolveImageRef("a.png", "/w", {
      isAnthropic: false,
      provider: "google",
      model: "gemini-2.5-pro", // image-capable per the snapshot
      encodeImageBlock: () => ({
        type: "image",
        source: { type: "base64", media_type: "image/png", data: "IMG" },
      }),
    })
    expect(r.kind).toBe("block")
  })

  it("OCRs to a <file> block when the model can't see images", async () => {
    const r = await resolveImageRef("a.png", "/w", {
      isAnthropic: false,
      provider: "deepseek",
      model: "deepseek-chat", // text-only per the snapshot
      readFileBytes: () => PNG,
      isFile: () => true,
      runOcr: async () => ({ ok: true, text: "extracted text" }),
    })
    expect(r).toEqual({ kind: "text", text: `<file path="a.png">\nextracted text\n</file>` })
  })

  it("fails when OCR is needed but the runner returns no text", async () => {
    const r = await resolveImageRef("a.png", "/w", {
      isAnthropic: false,
      provider: "deepseek",
      model: "deepseek-chat",
      readFileBytes: () => PNG,
      isFile: () => true,
      runOcr: async () => ({ ok: false, reason: "no-anthropic-key" }),
    })
    expect(r).toEqual({ kind: "failed", reason: "no-anthropic-key" })
  })

  it("fails when the OCR-fallback image is missing on disk", async () => {
    const r = await resolveImageRef("gone.png", "/w", {
      isAnthropic: false,
      provider: "deepseek",
      model: "deepseek-chat",
      isFile: () => false,
    })
    expect(r).toEqual({ kind: "failed" })
  })

  it("fails a native-path encode that returns null (unreadable image)", async () => {
    const r = await resolveImageRef("a.png", "/w", {
      isAnthropic: true,
      provider: "anthropic",
      model: "claude-opus-4-5",
      encodeImageBlock: () => null,
    })
    expect(r).toEqual({ kind: "failed" })
  })
})

import { ocrExtractText } from "./ocr"
import type { OcrInput, OcrResult } from "@/types/ocr"

const fakeResult = (combinedMarkdown: string): OcrResult =>
  ({ combinedMarkdown, combinedText: combinedMarkdown }) as unknown as OcrResult

describe("ocrExtractText", () => {
  it("passes a data-url source and returns combined markdown", async () => {
    let seenInput: OcrInput | undefined
    const r = await ocrExtractText(new Uint8Array([0x25, 0x50]).buffer, "application/pdf", {
      anthropicKey: () => "sk-test",
      extract: async (input) => {
        seenInput = input
        return fakeResult("# Extracted")
      },
    })
    expect(r).toEqual({ ok: true, text: "# Extracted" })
    expect(seenInput?.source.kind).toBe("data-url")
    expect(
      seenInput?.source.kind === "data-url" &&
        seenInput.source.dataUrl.startsWith("data:application/pdf;base64,")
    ).toBe(true)
    expect(seenInput?.useCache).toBe(false)
    expect(seenInput?.providerId).toBe("anthropic-vision")
  })

  it("fails closed with no Anthropic key", async () => {
    const r = await ocrExtractText(new ArrayBuffer(2), "application/pdf", {
      anthropicKey: () => null,
      extract: async () => fakeResult("x"),
    })
    expect(r).toEqual({ ok: false, reason: "no-anthropic-key" })
  })

  it("fails when extract throws", async () => {
    const r = await ocrExtractText(new ArrayBuffer(2), "application/pdf", {
      anthropicKey: () => "sk-test",
      extract: async () => {
        throw new Error("provider 500")
      },
    })
    expect(r.ok).toBe(false)
  })

  it("uses combinedText when combinedMarkdown is empty", async () => {
    const r = await ocrExtractText(new ArrayBuffer(2), "image/png", {
      anthropicKey: () => "k",
      extract: async () =>
        ({ combinedMarkdown: "", combinedText: "plain text" }) as unknown as OcrResult,
    })
    expect(r).toEqual({ ok: true, text: "plain text" })
  })

  it("fails when extract yields empty text", async () => {
    const r = await ocrExtractText(new ArrayBuffer(2), "application/pdf", {
      anthropicKey: () => "sk-test",
      extract: async () => fakeResult("   "),
    })
    expect(r).toEqual({ ok: false, reason: "empty" })
  })

  it("fails empty when both markdown and text are blank", async () => {
    const r = await ocrExtractText(new ArrayBuffer(2), "image/png", {
      anthropicKey: () => "k",
      extract: async () => ({ combinedMarkdown: "", combinedText: "" }) as unknown as OcrResult,
    })
    expect(r).toEqual({ ok: false, reason: "empty" })
  })

  it("builds a credentials resolver that surfaces the Anthropic key", async () => {
    let resolvedKey: string | null = "unset"
    await ocrExtractText(new ArrayBuffer(2), "application/pdf", {
      anthropicKey: () => "sk-main",
      extract: async (_input, deps) => {
        const creds = await deps.credentialsResolver("anthropic-vision", [])
        resolvedKey = (await creds.getMainProviderKey?.("anthropic")) ?? null
        const other = (await creds.getMainProviderKey?.("openai")) ?? null
        expect(other).toBeNull()
        expect(deps.registry.get("anthropic-vision")?.id).toBe("anthropic-vision")
        return fakeResult("ok")
      },
    })
    expect(resolvedKey).toBe("sk-main")
  })
})

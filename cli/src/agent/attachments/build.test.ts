import nodeFs from "node:fs"
import nodeOs from "node:os"
import nodePath from "node:path"

import { buildAttachmentContent, type BuildAttachmentDeps } from "./build"

const baseDeps: BuildAttachmentDeps = {
  provider: "anthropic",
  model: "claude-opus-4-5",
  isAnthropic: true,
  anthropicKey: () => "sk",
  encodeImageBlock: (ref: string) =>
    ref === "a.png"
      ? { type: "image", source: { type: "base64", media_type: "image/png", data: "IMG" } }
      : null,
  readTextFileBlock: (ref: string) =>
    ref === "main.ts" ? { ok: true, text: `<file path="main.ts">\ncode\n</file>` } : { ok: false },
  extractRichDocBlock: async (ref: string) =>
    ref === "deck.pptx"
      ? { ok: true, text: `<file path="deck.pptx">\nslides\n</file>` }
      : { ok: false },
  resolvePdfRef: async () => ({
    kind: "block",
    block: {
      type: "document",
      source: { type: "base64", media_type: "application/pdf", data: "PDF" },
    },
  }),
}

describe("buildAttachmentContent", () => {
  it("returns the plain string unchanged when there are no file refs", async () => {
    const r = await buildAttachmentContent("just text", "/w", baseDeps)
    expect(r.content).toBe("just text")
    expect(r.imageCount).toBe(0)
  })

  it("encodes an image into a content block array", async () => {
    const r = await buildAttachmentContent("look @a.png", "/w", baseDeps)
    expect(Array.isArray(r.content)).toBe(true)
    expect(r.imageCount).toBe(1)
    const blocks = r.content as SendContentBlockArray
    expect(blocks[0].type).toBe("text")
    expect(blocks[1]).toEqual({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "IMG" },
    })
  })

  it("OCRs an image to text when the active model can't see images", async () => {
    const r = await buildAttachmentContent("look @a.png", "/w", {
      ...baseDeps,
      isAnthropic: false,
      provider: "deepseek",
      model: "deepseek-chat", // text-only per the models.dev snapshot
      resolveImageRef: async () => ({
        kind: "text",
        text: `<file path="a.png">\nOCR\n</file>`,
      }),
    })
    expect(typeof r.content).toBe("string")
    expect(r.content).toContain("OCR")
    expect(r.ocr).toEqual(["a.png"])
    expect(r.injectedFiles).toEqual(["a.png"])
    expect(r.imageCount).toBe(0)
  })

  it("folds text-file content into the prompt string (no blocks)", async () => {
    const r = await buildAttachmentContent("explain @main.ts", "/w", baseDeps)
    expect(typeof r.content).toBe("string")
    expect(r.content).toContain('<file path="main.ts">')
    expect(r.injectedFiles).toEqual(["main.ts"])
  })

  it("folds rich-doc text into the prompt string", async () => {
    const r = await buildAttachmentContent("summarize @deck.pptx", "/w", baseDeps)
    expect(typeof r.content).toBe("string")
    expect(r.content).toContain("slides")
    expect(r.injectedFiles).toEqual(["deck.pptx"])
  })

  it("emits a native PDF document block", async () => {
    const r = await buildAttachmentContent("read @spec.pdf", "/w", baseDeps)
    const blocks = r.content as SendContentBlockArray
    expect(r.documentCount).toBe(1)
    expect(blocks.some((b) => b.type === "document")).toBe(true)
  })

  it("records a failed ref and notes it in the leading text", async () => {
    const r = await buildAttachmentContent("see @gone.md", "/w", baseDeps)
    expect(r.failed).toEqual(["gone.md"])
    expect(r.content).toContain("[could not read: gone.md]")
  })

  it("leaves an unknown extension literal and records it as skipped", async () => {
    const r = await buildAttachmentContent("got @archive.zip", "/w", baseDeps)
    expect(r.content).toBe("got @archive.zip")
    expect(r.skipped).toEqual(["archive.zip"])
  })

  it("tracks an OCR'd PDF when the strategy returns text", async () => {
    const r = await buildAttachmentContent("read @scan.pdf", "/w", {
      ...baseDeps,
      resolvePdfRef: async () => ({ kind: "text", text: `<file path="scan.pdf">\nOCR\n</file>` }),
    })
    expect(typeof r.content).toBe("string")
    expect(r.ocr).toEqual(["scan.pdf"])
    expect(r.injectedFiles).toEqual(["scan.pdf"])
  })

  // Exercises the REAL default handlers (fs reads, image encode, doc extract,
  // PDF native block) end-to-end against temp files — no injected overrides.
  it("drives the real fs/handler defaults end-to-end", async () => {
    const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "attach-"))
    try {
      nodeFs.writeFileSync(nodePath.join(dir, "a.md"), "# Title\nbody")
      nodeFs.writeFileSync(nodePath.join(dir, "shot.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
      nodeFs.writeFileSync(nodePath.join(dir, "doc.pdf"), Buffer.from([0x25, 0x50, 0x44, 0x46]))
      nodeFs.writeFileSync(nodePath.join(dir, "notes.rtf"), "{\\rtf1 hello world}")
      const r = await buildAttachmentContent("look @a.md @shot.png @doc.pdf @notes.rtf", dir, {
        provider: "anthropic",
        model: "claude-opus-4-5",
        isAnthropic: true,
        anthropicKey: () => "sk",
      })
      expect(Array.isArray(r.content)).toBe(true)
      const blocks = r.content as SendContentBlockArray
      expect(blocks[0].type).toBe("text")
      expect(String(blocks[0].text)).toContain("# Title")
      expect(r.imageCount).toBe(1)
      expect(r.documentCount).toBe(1)
      expect(r.injectedFiles).toContain("a.md")
      // The rtf went through the real document processor (inlined or failed).
      expect([...r.injectedFiles, ...r.failed]).toContain("notes.rtf")
    } finally {
      nodeFs.rmSync(dir, { recursive: true, force: true })
    }
  })

  // Real text-file default path: a missing ref with no injected handlers.
  it("records a missing text ref using the real reader default", async () => {
    const r = await buildAttachmentContent("see @nope.md", nodeOs.tmpdir(), {
      provider: "anthropic",
      model: "claude-opus-4-5",
      isAnthropic: true,
      anthropicKey: () => null,
    })
    expect(r.failed).toEqual(["nope.md"])
    expect(typeof r.content).toBe("string")
  })
})

type SendContentBlockArray = Array<{ type: string } & Record<string, unknown>>

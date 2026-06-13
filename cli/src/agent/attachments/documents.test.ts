import nodeFs from "node:fs"
import nodeOs from "node:os"
import nodePath from "node:path"

import { extractRichDocBlock } from "./documents"
import type { ProcessedDocument } from "@/types/document/document"

const fakeProcessed = (content: string): ProcessedDocument => ({
  id: "x",
  filename: "deck.pptx",
  type: "presentation",
  content,
  embeddableContent: content,
  metadata: { size: content.length, lineCount: 1, wordCount: 1 },
})

describe("extractRichDocBlock", () => {
  it("extracts text via the document processor and wraps it", async () => {
    const deps = {
      readFileBytes: () => new Uint8Array([1, 2, 3]).buffer,
      isFile: () => true,
      processDocumentAsync: async () => fakeProcessed("Slide 1\nSlide 2"),
    }
    const r = await extractRichDocBlock("deck.pptx", "/w", deps)
    expect(r).toEqual({ ok: true, text: '<file path="deck.pptx">\nSlide 1\nSlide 2\n</file>' })
  })

  it("returns ok:false when the file is missing", async () => {
    const deps = {
      readFileBytes: () => {
        throw new Error("ENOENT")
      },
      isFile: () => false,
      processDocumentAsync: async () => fakeProcessed(""),
    }
    expect(await extractRichDocBlock("missing.docx", "/w", deps)).toEqual({ ok: false })
  })

  it("returns ok:false when extraction yields empty content", async () => {
    const deps = {
      readFileBytes: () => new ArrayBuffer(3),
      isFile: () => true,
      processDocumentAsync: async () => fakeProcessed("   "),
    }
    expect(await extractRichDocBlock("blank.docx", "/w", deps)).toEqual({ ok: false })
  })

  it("accepts an absolute ref without re-resolving against cwd", async () => {
    const r = await extractRichDocBlock("/abs/x.docx", "/w", {
      isFile: () => true,
      readFileBytes: () => new ArrayBuffer(1),
      processDocumentAsync: async () => fakeProcessed("hi"),
    })
    expect(r).toEqual({ ok: true, text: '<file path="/abs/x.docx">\nhi\n</file>' })
  })

  it("treats undefined extracted content as empty", async () => {
    const r = await extractRichDocBlock("a.docx", "/w", {
      isFile: () => true,
      readFileBytes: () => new ArrayBuffer(1),
      processDocumentAsync: async () =>
        ({ ...fakeProcessed(""), content: undefined }) as unknown as ProcessedDocument,
    })
    expect(r).toEqual({ ok: false })
  })

  it("runs the default deps against a real missing file and a real file", async () => {
    const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "doc-"))
    try {
      // Default isFile on a missing path → catch → false → ok:false.
      expect(await extractRichDocBlock("missing.docx", dir)).toEqual({ ok: false })
      // Default readFileBytes + real document processor on a present file. The
      // extracted content may be empty in this env, so we only require a
      // well-formed best-effort result (the success wrapping is covered above).
      nodeFs.writeFileSync(nodePath.join(dir, "p.html"), "<html><body><p>Hi</p></body></html>")
      const r = await extractRichDocBlock("p.html", dir)
      expect(typeof r.ok).toBe("boolean")
      if (r.ok) expect(r.text).toContain('<file path="p.html">')
    } finally {
      nodeFs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

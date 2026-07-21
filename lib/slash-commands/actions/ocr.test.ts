import { createNullOcrCache, createNullOcrPageCache } from "@/lib/ocr/cache-contract"
import { buildOcrResultPart, handleOcrSlashCommand, parseOcrArgs } from "./ocr"
import { createOcrRegistry } from "@/lib/ocr/registry"
import { DEFAULT_OCR_SETTINGS, type OcrResult } from "@/types/ocr"
import { OcrError } from "@/lib/ocr/errors"
import type { ExtractDeps } from "@/lib/ocr/index"

function makeDeps(): ExtractDeps {
  return {
    registry: createOcrRegistry(),
    settings: { ...DEFAULT_OCR_SETTINGS },
    platform: "web",
    credentialsResolver: async () => ({ secrets: {} }),
    cache: createNullOcrCache(),
    pageCache: createNullOcrPageCache(),
  }
}

const sampleResult: OcrResult = {
  providerId: "mock",
  pages: [{ pageNumber: 1, markdown: "# Hello", text: "Hello" }],
  combinedMarkdown: "# Hello",
  combinedText: "Hello",
  languages: ["en"],
  durationMs: 12,
  cached: false,
}

describe("parseOcrArgs", () => {
  it("treats att_* as an attachment-id source", () => {
    const out = parseOcrArgs("att_123")
    expect(out.source).toEqual({ kind: "attachment-id", attachmentId: "att_123" })
    expect(out.into).toBe("composer")
  })

  it("treats /path/to/file as a file-path source", () => {
    const out = parseOcrArgs("/tmp/scan.png")
    expect(out.source).toEqual({ kind: "file-path", path: "/tmp/scan.png" })
  })

  it("honours quoted paths with spaces", () => {
    const out = parseOcrArgs('"C:\\Users\\Me\\My File.png"')
    expect(out.source).toEqual({ kind: "file-path", path: "C:\\Users\\Me\\My File.png" })
  })

  it("parses --provider", () => {
    expect(parseOcrArgs("att_1 --provider mistral-ocr").provider).toBe("mistral-ocr")
    expect(parseOcrArgs("att_1 -p tesseract-wasm").provider).toBe("tesseract-wasm")
  })

  it("parses --lang into an array", () => {
    expect(parseOcrArgs("att_1 --lang en,zh").languages).toEqual(["en", "zh"])
    expect(parseOcrArgs("att_1 -l fr").languages).toEqual(["fr"])
  })

  it("parses --pages and --format", () => {
    const out = parseOcrArgs("att_1 --pages 1-3 --format blocks")
    expect(out.pageRange).toBe("1-3")
    expect(out.format).toBe("blocks")
  })

  it("rejects unknown flags", () => {
    expect(() => parseOcrArgs("att_1 --bogus")).toThrow(/Unknown flag/)
  })

  it("rejects --format with invalid values", () => {
    expect(() => parseOcrArgs("att_1 --format html")).toThrow(/--format/)
  })

  it("rejects --into with invalid values", () => {
    expect(() => parseOcrArgs("att_1 --into nowhere")).toThrow(/--into/)
  })

  it("rejects when argv is empty", () => {
    expect(() => parseOcrArgs("")).toThrow(/Missing argument/)
  })

  it("rejects flags without values", () => {
    expect(() => parseOcrArgs("att_1 --provider")).toThrow(/--provider requires a value/)
    expect(() => parseOcrArgs("att_1 --lang")).toThrow(/--lang requires a value/)
    expect(() => parseOcrArgs("att_1 --pages")).toThrow(/--pages requires a value/)
  })
})

describe("handleOcrSlashCommand", () => {
  it("returns a system message + composer text on success", async () => {
    const out = await handleOcrSlashCommand({
      argv: "att_1",
      deps: makeDeps(),
      extractImpl: async () => sampleResult,
    })
    expect(out.errorCode).toBeUndefined()
    expect(out.system).toContain("# Hello")
    expect(out.composerText).toBe("# Hello")
    expect(out.result).toBe(sampleResult)
  })

  it("returns invalid_input on parse failure", async () => {
    const out = await handleOcrSlashCommand({
      argv: "",
      deps: makeDeps(),
      extractImpl: async () => sampleResult,
    })
    expect(out.errorCode).toBe("invalid_input")
    expect(out.system).toMatch(/Missing argument/)
  })

  it("forwards --into system without populating composerText", async () => {
    const out = await handleOcrSlashCommand({
      argv: "att_1 --into system",
      deps: makeDeps(),
      extractImpl: async () => sampleResult,
    })
    expect(out.composerText).toBeUndefined()
  })

  it("returns an attachment-id sourceRef for an att_* source (gap4)", async () => {
    const out = await handleOcrSlashCommand({
      argv: "att_9",
      deps: makeDeps(),
      extractImpl: async () => sampleResult,
    })
    expect(out.sourceRef).toEqual({ kind: "attachment-id", value: "att_9" })
  })

  it("returns a file-path sourceRef for a path source (gap4)", async () => {
    const out = await handleOcrSlashCommand({
      argv: "/tmp/scan.png",
      deps: makeDeps(),
      extractImpl: async () => sampleResult,
    })
    expect(out.sourceRef).toEqual({ kind: "file-path", value: "/tmp/scan.png" })
  })

  it("propagates OcrError code on extraction failure", async () => {
    const out = await handleOcrSlashCommand({
      argv: "att_1",
      deps: makeDeps(),
      extractImpl: async () => {
        throw new OcrError("rate_limited", "mock", "slow")
      },
    })
    expect(out.errorCode).toBe("rate_limited")
    expect(out.system).toContain("rate_limited")
  })

  it("falls back to provider_failed for non-OcrError throws", async () => {
    const out = await handleOcrSlashCommand({
      argv: "att_1",
      deps: makeDeps(),
      extractImpl: async () => {
        throw new Error("network down")
      },
    })
    expect(out.errorCode).toBe("provider_failed")
    expect(out.system).toContain("network down")
  })

  it("threads attachmentResolver / filePathResolver into deps", async () => {
    const attachmentResolver = jest.fn(async () => ({
      blob: new Blob([new Uint8Array([1])]),
      mimeType: "image/png",
    }))
    const captured: Array<ExtractDeps | undefined> = []
    await handleOcrSlashCommand({
      argv: "att_1",
      deps: makeDeps(),
      attachmentResolver,
      extractImpl: async (_input, deps) => {
        captured.push(deps)
        return sampleResult
      },
    })
    expect(captured[0]?.attachmentResolver).toBe(attachmentResolver)
  })
})

describe("buildOcrResultPart (gap4)", () => {
  it("maps an OcrResult into an ocr-result part", () => {
    const part = buildOcrResultPart(sampleResult, { kind: "file-path", value: "/x.png" })
    expect(part).toMatchObject({
      type: "ocr-result",
      providerId: "mock",
      languages: ["en"],
      text: "Hello",
      markdown: "# Hello",
      durationMs: 12,
      cached: false,
      sourceRef: { kind: "file-path", value: "/x.png" },
    })
  })

  it("reports null confidence when the result has no document", () => {
    expect(buildOcrResultPart(sampleResult).confidence).toBeNull()
  })

  it("computes mean confidence from the document blocks", () => {
    const withDoc: OcrResult = {
      ...sampleResult,
      document: {
        pages: [
          {
            pageNumber: 1,
            width: 0,
            height: 0,
            blocks: [
              { id: "b1", text: "a", confidence: 0.9, bbox: { x: 0, y: 0, width: 1, height: 1 } },
              { id: "b2", text: "b", confidence: 0.7, bbox: { x: 0, y: 0, width: 1, height: 1 } },
            ],
          },
        ],
      } as never,
    }
    expect(buildOcrResultPart(withDoc).confidence).toBeCloseTo(0.8)
  })

  it("omits sourceRef when none is provided", () => {
    expect(buildOcrResultPart(sampleResult).sourceRef).toBeUndefined()
  })
})

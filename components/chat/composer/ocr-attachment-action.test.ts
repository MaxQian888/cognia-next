import { applyComposerOcr } from "./ocr-attachment-action"
import type { OcrResult } from "@/types/ocr"

function mkResult(text: string): OcrResult {
  return {
    providerId: "tesseract-wasm",
    pages: [{ pageNumber: 1, markdown: text, text }],
    combinedMarkdown: text,
    combinedText: text,
    languages: ["en"],
    durationMs: 1,
    cached: false,
  }
}

const blob = new Blob(["x"], { type: "image/png" })

describe("applyComposerOcr", () => {
  it("appends extracted text to a non-empty draft with a blank-line separator", async () => {
    let value = "hello"
    const run = jest.fn(async () => mkResult("WORLD"))
    const showResult = jest.fn()
    await applyComposerOcr({
      action: "extract-to-input",
      blob,
      mimeType: "image/png",
      run,
      getInput: () => value,
      setInput: (v) => {
        value = v
      },
      showResult,
    })
    expect(value).toBe("hello\n\nWORLD")
    expect(showResult).not.toHaveBeenCalled()
    expect(run).toHaveBeenCalledWith({
      source: { kind: "blob", blob, mimeType: "image/png" },
    })
  })

  it("does not prepend a separator when the draft is empty", async () => {
    let value = ""
    await applyComposerOcr({
      action: "extract-to-input",
      blob,
      mimeType: "image/png",
      run: async () => mkResult("ONLY"),
      getInput: () => value,
      setInput: (v) => {
        value = v
      },
      showResult: jest.fn(),
    })
    expect(value).toBe("ONLY")
  })

  it("opens the result sheet for view-result without touching the draft", async () => {
    const setInput = jest.fn()
    const showResult = jest.fn()
    const result = mkResult("PAGE")
    await applyComposerOcr({
      action: "view-result",
      blob,
      mimeType: "image/png",
      run: async () => result,
      getInput: () => "draft",
      setInput,
      showResult,
    })
    expect(showResult).toHaveBeenCalledWith(result)
    expect(setInput).not.toHaveBeenCalled()
  })

  it("is a no-op when extraction fails (run returns null)", async () => {
    const setInput = jest.fn()
    const showResult = jest.fn()
    await applyComposerOcr({
      action: "extract-to-input",
      blob,
      mimeType: "image/png",
      run: async () => null,
      getInput: () => "draft",
      setInput,
      showResult,
    })
    expect(setInput).not.toHaveBeenCalled()
    expect(showResult).not.toHaveBeenCalled()
  })
})

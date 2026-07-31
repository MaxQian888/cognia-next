import {
  DEFAULT_MAX_IMAGE_DIMENSION,
  DEFAULT_VISION_PROMPT,
  buildVisionResult,
  preparePromptAndImage,
} from "./_llm-vision"
import type { OcrInput, OcrProviderContext } from "../types"

const input: OcrInput = {
  source: {
    kind: "data-url",
    dataUrl: "data:image/png;base64,YWJj",
    mimeType: "image/png",
  },
  languages: ["en"],
}

function makeCtx(): OcrProviderContext {
  return {
    credentials: { secrets: {} },
    config: {},
    platform: "web",
  }
}

describe("DEFAULT_VISION_PROMPT / DEFAULT_MAX_IMAGE_DIMENSION", () => {
  it("starts with an extraction-oriented instruction", () => {
    expect(DEFAULT_VISION_PROMPT.toLowerCase()).toContain("extract")
  })
  it("uses a 2000px ceiling by default", () => {
    expect(DEFAULT_MAX_IMAGE_DIMENSION).toBe(2000)
  })
})

describe("preparePromptAndImage", () => {
  it("returns the configured prompt and base bytes", async () => {
    const out = await preparePromptAndImage(input, makeCtx(), {
      promptTemplate: "Hello",
    })
    expect(out.prompt).toBe("Hello")
    expect(out.mimeType).toBe("image/png")
    expect(Array.from(out.bytes)).toEqual([0x61, 0x62, 0x63])
  })

  it("falls back to the default prompt", async () => {
    const out = await preparePromptAndImage(input, makeCtx(), {})
    expect(out.prompt).toBe(DEFAULT_VISION_PROMPT.trim())
  })

  it("trims whitespace from the prompt template", async () => {
    const out = await preparePromptAndImage(input, makeCtx(), {
      promptTemplate: "  trimmed  ",
    })
    expect(out.prompt).toBe("trimmed")
  })
})

describe("buildVisionResult", () => {
  it("returns a single-page result with markdown + stripped text", () => {
    const out = buildVisionResult("anthropic-vision", "# Hello\nbody", input, Date.now() - 5)
    expect(out.providerId).toBe("anthropic-vision")
    expect(out.pages).toHaveLength(1)
    expect(out.pages[0]!.markdown).toContain("# Hello")
    expect(out.pages[0]!.text).not.toContain("#")
    expect(out.pages[0]!.text).toContain("Hello")
    expect(out.cached).toBe(false)
    expect(out.durationMs).toBeGreaterThanOrEqual(0)
  })

  it("strips inline markdown decorations from the text fallback", () => {
    const out = buildVisionResult(
      "openai-vision",
      "**bold** _italic_ `code` [link](http://x) ![img](http://y)",
      input,
      Date.now()
    )
    expect(out.pages[0]!.text).toContain("bold")
    expect(out.pages[0]!.text).toContain("italic")
    expect(out.pages[0]!.text).toContain("code")
    expect(out.pages[0]!.text).toContain("link")
    expect(out.pages[0]!.text).not.toContain("[")
    expect(out.pages[0]!.text).not.toContain("![")
  })
})

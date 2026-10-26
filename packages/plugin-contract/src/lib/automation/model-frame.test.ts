import {
  carriesFrame,
  frameToModelContent,
  screenshotMetadata,
  screenshotMimeType,
} from "./model-frame"
import type { Screenshot } from "./types"

function shot(overrides: Partial<Screenshot> = {}): Screenshot {
  return {
    bytes: "AAAA",
    width: 1600,
    height: 1000,
    capturedAt: 1_700_000_000,
    format: "png",
    ...overrides,
  }
}

describe("screenshotMimeType", () => {
  it("maps the backend format enum onto media types", () => {
    expect(screenshotMimeType("png")).toBe("image/png")
    expect(screenshotMimeType("jpeg")).toBe("image/jpeg")
  })
})

describe("screenshotMetadata", () => {
  it("keeps every field except the payload", () => {
    const meta = screenshotMetadata(shot({ sourceWidth: 3200, sourceHeight: 2000 }))
    expect(meta).toEqual({
      width: 1600,
      height: 1000,
      capturedAt: 1_700_000_000,
      format: "png",
      sourceWidth: 3200,
      sourceHeight: 2000,
    })
    expect("bytes" in meta).toBe(false)
  })
})

describe("frameToModelContent", () => {
  it("emits the frame as an image block, not as stringified base64", () => {
    const { content } = frameToModelContent({ revision: 3, screenshot: shot() })
    expect(content[0]).toEqual({ type: "image", data: "AAAA", mimeType: "image/png" })
  })

  it("never carries the bytes twice", () => {
    const { content, json } = frameToModelContent({ revision: 3, screenshot: shot() })
    const text = content.find((block) => block.type === "text")
    expect(text).toBeDefined()
    expect(text && "text" in text ? text.text : "").not.toContain("AAAA")
    expect(JSON.stringify(json)).not.toContain("AAAA")
  })

  it("keeps the dimensions so a pixel target stays addressable", () => {
    const { json } = frameToModelContent({ revision: 3, screenshot: shot() })
    expect(json.screenshot).toMatchObject({ width: 1600, height: 1000 })
  })

  it("sends no image block when the frame was withheld as unchanged", () => {
    const { content } = frameToModelContent({
      revision: 4,
      screenshotUnchanged: true,
      screenshot: shot({ bytes: "" }),
    })
    expect(content.filter((block) => block.type === "image")).toHaveLength(0)
    expect(content).toHaveLength(1)
  })

  it("tolerates a payload with no frame at all", () => {
    const { content, json } = frameToModelContent({ revision: 5, screenshot: null })
    expect(content).toHaveLength(1)
    expect(json.screenshot).toBeNull()
  })

  it("preserves the rest of the payload verbatim", () => {
    const { json } = frameToModelContent({
      sessionId: "s1",
      lineageId: "l1",
      revision: 7,
      screenshot: shot(),
    })
    expect(json).toMatchObject({ sessionId: "s1", lineageId: "l1", revision: 7 })
  })
})

describe("carriesFrame", () => {
  it("recognises a capture-bearing payload", () => {
    expect(carriesFrame({ screenshot: shot() })).toBe(true)
    expect(carriesFrame({ screenshot: null })).toBe(true)
  })

  it("rejects payloads that have no frame", () => {
    expect(carriesFrame({ apps: [] })).toBe(false)
    expect(carriesFrame(null)).toBe(false)
    expect(carriesFrame("string")).toBe(false)
    expect(carriesFrame({ screenshot: { width: 10 } })).toBe(false)
  })
})

/** @jest-environment node */
import { MAX_CANVAS_SIDE } from "../agent/image-ops"
import {
  CAPTURE_SPACING_MS,
  captureFullPage,
  captureVisible,
  fileNameFromUrl,
  regionInImagePixels,
  screenshotAttachment,
  sniffMediaType,
} from "./screenshots"

function fakeApi(
  metrics = { scrollHeight: 2_500, viewportHeight: 1_000, viewportWidth: 500, scrollY: 40, dpr: 2 }
) {
  let clock = 0
  const calls: string[] = []
  const captures: number[] = []
  const api = {
    activateTab: async (id: number) => {
      calls.push(`activate:${id}`)
    },
    captureVisible: async (windowId: number) => {
      captures.push(clock)
      calls.push(`capture:${windowId}`)
      return "data:image/png;base64,AAAA"
    },
    scrollMetrics: async () => metrics,
    scrollTo: async (_tab: number, y: number) => {
      calls.push(`scroll:${y}`)
      return Math.min(y, metrics.scrollHeight - metrics.viewportHeight)
    },
    cropImage: async () => "",
    stitchImages: async (shots: string[], width: number, heights: number[]) =>
      `${shots.length}:${width}:${heights.join("+")}`,
  }
  const sleep = async (ms: number) => {
    clock += ms
  }
  return { api, calls, captures, sleep }
}

const TAB = { id: 7, url: "https://a.test/", title: "A", windowId: 3 }

describe("captureVisible", () => {
  it("brings the tab to front and captures its window", async () => {
    const { api, calls, sleep } = fakeApi()
    await expect(captureVisible(api, TAB, sleep)).resolves.toBe("data:image/png;base64,AAAA")
    expect(calls).toEqual(["activate:7", "capture:3"])
    await expect(captureVisible(api, { ...TAB, windowId: undefined }, sleep)).rejects.toThrow(
      "window"
    )
  })
})

describe("captureFullPage", () => {
  it("stitches spaced captures, keeping only new rows of the last, and restores the scroll", async () => {
    const { api, calls, captures, sleep } = fakeApi()
    const result = await captureFullPage(api, TAB, sleep)
    expect(result).toEqual({
      base64: "3:1000:2000+2000+1000",
      width: 1_000,
      height: 5_000,
      truncated: false,
    })
    expect(captures[2]! - captures[1]!).toBeGreaterThanOrEqual(CAPTURE_SPACING_MS)
    expect(calls.at(-1)).toBe("scroll:40")
  })

  it("says when the page was cut", async () => {
    const { api, sleep } = fakeApi({
      scrollHeight: 50_000,
      viewportHeight: 1_000,
      viewportWidth: 500,
      scrollY: 0,
      dpr: 1,
    })
    const result = await captureFullPage(api, TAB, sleep)
    expect(result.truncated).toBe(true)
    expect(result.height).toBeLessThanOrEqual(MAX_CANVAS_SIDE)
  })
})

describe("helpers", () => {
  it("maps a dragged rectangle into image pixels, in any drag direction", () => {
    expect(
      regionInImagePixels(
        { x: 100, y: 50, width: -50, height: -25 },
        { width: 200, height: 100 },
        { width: 800, height: 400 }
      )
    ).toEqual({
      x: 200,
      y: 100,
      width: 200,
      height: 100,
    })
    expect(
      regionInImagePixels(
        { x: 190, y: 90, width: 100, height: 100 },
        { width: 200, height: 100 },
        { width: 200, height: 100 }
      )
    ).toEqual({
      x: 190,
      y: 90,
      width: 10,
      height: 10,
    })
  })

  it("builds a screenshot attachment", () => {
    const attachment = screenshotAttachment("a1", "AQID", Date.UTC(2026, 9, 16, 12, 0, 0), "region")
    expect(attachment).toMatchObject({
      id: "a1",
      name: "screenshot-region-2026-10-16T12-00-00.png",
      mediaType: "image/png",
      kind: "screenshot",
      previewUrl: "data:image/png;base64,AQID",
    })
    expect([...attachment.bytes]).toEqual([1, 2, 3])
  })

  it("names files from their URL", () => {
    expect(fileNameFromUrl("https://a.test/docs/My%20Paper.pdf?x=1", "doc.pdf")).toBe(
      "My Paper.pdf"
    )
    expect(fileNameFromUrl("https://a.test/", "doc.pdf")).toBe("doc.pdf")
    expect(fileNameFromUrl("nope", "doc.pdf")).toBe("doc.pdf")
  })

  it("sniffs common file types", () => {
    expect(
      sniffMediaType(new Uint8Array([0x25, 0x50, 0x44, 0x46]), "application/octet-stream")
    ).toBe("application/pdf")
    expect(sniffMediaType(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), "")).toBe("image/png")
    expect(sniffMediaType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]), "")).toBe("image/jpeg")
    expect(
      sniffMediaType(
        new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]),
        ""
      )
    ).toBe("image/webp")
    expect(sniffMediaType(new Uint8Array([1, 2, 3]), "text/html")).toBe("text/html")
  })
})

jest.mock("./client", () => ({
  desktop: { screenshot: jest.fn(), click: jest.fn(async () => {}) },
}))
jest.mock("@/lib/ocr", () => ({ extract: jest.fn() }))
jest.mock("@/lib/ocr/deps", () => ({ buildOcrDeps: jest.fn(() => ({})) }))

import {
  blocksToScreenMatches,
  rankMatches,
  findScreenTextWith,
  clickScreenTextWith,
  findScreenText,
  clickScreenText,
  type OcrClickDeps,
  type ScreenTextMatch,
} from "./ocr-click"
import { desktop } from "./client"
import { extract } from "@/lib/ocr"
import { OcrError } from "@/lib/ocr/errors"
import {
  clearComputerUsePipState,
  getComputerUsePipSnapshot,
  beginComputerUsePipRun,
  getComputerUsePipCaptureSuppressed,
} from "./computer-use-pip"
import type { Screenshot } from "./types"
import type { OcrResult } from "@/types/ocr"

const mockedScreenshot = desktop.screenshot as jest.Mock
const mockedClick = desktop.click as jest.Mock
const mockedExtract = extract as unknown as jest.Mock

function shot(over: Partial<Screenshot> = {}): Screenshot {
  return { bytes: "AAAA", width: 1920, height: 1080, capturedAt: 0, format: "png", ...over }
}

function ocrResult(
  blocks: OcrResult["pages"][number]["blocks"],
  page: Partial<OcrResult["pages"][number]> = {}
): OcrResult {
  return {
    providerId: "tesseract",
    pages: [{ pageNumber: 1, markdown: "", text: "", blocks, ...page }],
    combinedMarkdown: "",
    combinedText: "",
    languages: ["en"],
    durationMs: 1,
    cached: false,
  }
}

describe("blocksToScreenMatches", () => {
  it("maps bbox to its center at scale 1", () => {
    const r = ocrResult([{ text: "Save", bbox: { x: 100, y: 200, width: 40, height: 20 } }])
    const out = blocksToScreenMatches(r, shot())
    expect(out[0].center).toEqual({ x: 120, y: 210 })
    expect(out[0].text).toBe("Save")
  })

  it("scales up when the Rust screenshot was downscaled", () => {
    // Captured at 960×540 but the real screen is 1920×1080 (sourceWidth/Height).
    const r = ocrResult([{ text: "X", bbox: { x: 100, y: 100, width: 20, height: 20 } }], {
      width: 960,
      height: 540,
    })
    const out = blocksToScreenMatches(
      r,
      shot({ width: 960, height: 540, sourceWidth: 1920, sourceHeight: 1080 })
    )
    // factor = sourceWidth / pageWidth = 1920/960 = 2
    expect(out[0].center).toEqual({ x: 220, y: 220 })
  })

  it("skips blocks without geometry and returns [] for an empty result", () => {
    expect(blocksToScreenMatches(ocrResult([{ text: "no bbox" }]), shot())).toEqual([])
    expect(blocksToScreenMatches(ocrResult(undefined), shot())).toEqual([])
  })
})

describe("rankMatches", () => {
  const mk = (text: string, conf?: number, y = 0): ScreenTextMatch => ({
    text,
    bbox: { x: 0, y, width: 10, height: 10 },
    center: { x: 5, y: y + 5 },
    confidence: conf,
  })

  it("ranks exact > prefix > substring and drops non-matches", () => {
    // "Submit Now" is a prefix match; "Click Submit" only a substring; "Cancel"
    // doesn't match at all and is dropped.
    const ranked = rankMatches(
      [mk("Click Submit"), mk("Submit"), mk("Submit Now"), mk("Cancel")],
      "submit"
    )
    expect(ranked.map((m) => m.text)).toEqual(["Submit", "Submit Now", "Click Submit"])
  })

  it("breaks ties by confidence then reading order", () => {
    const ranked = rankMatches([mk("OK", 0.5, 100), mk("OK", 0.9, 200)], "ok")
    expect(ranked[0].confidence).toBe(0.9)
  })
})

function deps(over: Partial<OcrClickDeps> = {}): OcrClickDeps {
  return {
    screenshot: jest.fn(async () => shot()),
    extract: jest.fn(async () =>
      ocrResult([{ text: "Submit", bbox: { x: 10, y: 20, width: 40, height: 10 } }])
    ),
    click: jest.fn(async () => {}),
    ocrDeps: {} as never,
    ...over,
  }
}

describe("findScreenTextWith", () => {
  it("captures, OCRs, and returns ranked matches for a query", async () => {
    const d = deps()
    const res = await findScreenTextWith(d, { query: "submit" })
    expect(res.ok).toBe(true)
    expect(res.matches[0].center).toEqual({ x: 30, y: 25 })
    expect(res.capture).toEqual({ width: 1920, height: 1080, coordinateSpace: "desktop" })
    expect(d.screenshot).toHaveBeenCalled()
  })

  it("throws a typed OcrError when the provider returns no geometry", async () => {
    const d = deps({ extract: jest.fn(async () => ocrResult([{ text: "no bbox" }])) })
    await expect(findScreenTextWith(d, { query: "x" })).rejects.toBeInstanceOf(OcrError)
  })
})

describe("clickScreenTextWith", () => {
  it("clicks the matched block's center and stamps click coords", async () => {
    const d = deps()
    const res = await clickScreenTextWith(d, { query: "submit" })
    expect(res.clicked.text).toBe("Submit")
    expect(d.click).toHaveBeenCalledWith(
      { x: 30, y: 25 },
      expect.objectContaining({ clickX: 30, clickY: 25, surface: "computerUse" })
    )
  })

  it("selects the Nth occurrence", async () => {
    const d = deps({
      extract: jest.fn(async () =>
        ocrResult([
          { text: "Row", bbox: { x: 0, y: 0, width: 10, height: 10 } },
          { text: "Row", bbox: { x: 0, y: 100, width: 10, height: 10 } },
        ])
      ),
    })
    const res = await clickScreenTextWith(d, { query: "Row", occurrence: 2 })
    expect(res.clicked.center.y).toBe(105)
  })

  it("throws when no block matches", async () => {
    const d = deps()
    await expect(clickScreenTextWith(d, { query: "missing" })).rejects.toBeInstanceOf(OcrError)
    expect(d.click).not.toHaveBeenCalled()
  })
})

describe("production entries (findScreenText / clickScreenText)", () => {
  it("keeps JPEG format and ignores an OCR frame completed after its run ended", async () => {
    mockedScreenshot.mockResolvedValueOnce(shot({ bytes: "JPEG", format: "jpeg", capturedAt: 10 }))
    await findScreenText({ query: "login", ctx: { surface: "computerUse", sessionKey: "jpeg" } })
    expect(getComputerUsePipSnapshot("jpeg").frame?.src).toBe("data:image/jpeg;base64,JPEG")
    beginComputerUsePipRun("jpeg", 1)
    mockedScreenshot.mockImplementationOnce(async () => {
      beginComputerUsePipRun("jpeg", 2)
      return shot({ bytes: "LATE", capturedAt: 100 })
    })
    await findScreenText({ query: "login", ctx: { surface: "computerUse", sessionKey: "jpeg" } })
    expect(getComputerUsePipSnapshot("jpeg")).toMatchObject({
      runId: 2,
      frame: null,
      action: null,
      captureSuppressed: false,
    })
  })
  beforeEach(() => {
    mockedScreenshot.mockReset().mockResolvedValue(shot())
    mockedClick.mockReset().mockResolvedValue(undefined)
    mockedExtract
      .mockReset()
      .mockResolvedValue(
        ocrResult([{ text: "Login", bbox: { x: 10, y: 10, width: 60, height: 20 } }])
      )
  })

  afterEach(() => {
    clearComputerUsePipState()
  })

  it("findScreenText wires the gated screenshot + OCR pipeline", async () => {
    const res = await findScreenText({ query: "login" })
    expect(mockedScreenshot).toHaveBeenCalled()
    expect(res.matches[0].center).toEqual({ x: 40, y: 20 })
  })

  it("publishes capture-safe find_text activity and its frame to the chat PiP", async () => {
    mockedScreenshot.mockImplementationOnce(async () => {
      expect(getComputerUsePipCaptureSuppressed()).toBe(true)
      return shot({ bytes: "OCR_FRAME", width: 1280, height: 800 })
    })

    await findScreenText({
      query: "login",
      ctx: { surface: "computerUse", sessionKey: "session-1" },
    })
    expect(getComputerUsePipCaptureSuppressed()).toBe(false)

    expect(getComputerUsePipSnapshot("session-1")).toMatchObject({
      action: "find_text",
      phase: "complete",
      captureSuppressed: false,
      frame: {
        src: "data:image/png;base64,OCR_FRAME",
        width: 1280,
        height: 800,
      },
    })
  })

  it("clickScreenText clicks the matched center via the gated desktop.click", async () => {
    await clickScreenText({ query: "login", button: "left" })
    expect(mockedClick).toHaveBeenCalledWith(
      { kind: "point", x: 40, y: 20 },
      { button: "left", double: undefined },
      expect.objectContaining({ clickX: 40, clickY: 20 })
    )
  })

  it("publishes click_text completion for a session-aware OCR click", async () => {
    await clickScreenText({
      query: "login",
      button: "left",
      ctx: { surface: "computerUse", sessionKey: "session-1" },
    })

    expect(getComputerUsePipSnapshot("session-1")).toMatchObject({
      action: "click_text",
      phase: "complete",
      captureSuppressed: false,
      frame: { src: "data:image/png;base64,AAAA" },
    })
  })

  it.each([
    ["find_text", () => findScreenText({ query: "login", ctx: sessionContext() })],
    [
      "click_text",
      () => clickScreenText({ query: "login", button: "left", ctx: sessionContext() }),
    ],
  ] as const)("releases suppression and surfaces %s capture failures", async (action, invoke) => {
    mockedScreenshot.mockRejectedValueOnce(new Error("capture denied"))

    await expect(invoke()).rejects.toThrow("capture denied")
    expect(getComputerUsePipSnapshot("session-1")).toMatchObject({
      action,
      phase: "error",
      error: "capture denied",
      captureSuppressed: false,
    })
  })
})

function sessionContext() {
  return { surface: "computerUse" as const, sessionKey: "session-1" }
}

describe("revision-bound app OCR", () => {
  const state = {
    sessionId: "app",
    lineageId: "line",
    revision: 7,
    turnToken: "single-use",
    surface: { pixelWidth: 800, pixelHeight: 600 },
  }
  const zoomed = {
    ...state,
    surface: {
      ...state.surface,
      windowId: 1,
      displayId: "main",
      logicalBounds: { x: 0, y: 0, width: 800, height: 600 },
      scaleFactor: 2,
      coordinateSpace: "screenshotPixels" as const,
    },
    screenshot: shot({ width: 1600, height: 1200 }),
    region: { x: 0, y: 0, width: 800, height: 600 },
    scale: 2,
  }
  it("reads the host-held frame and maps OCR pixels back to the shown app frame", async () => {
    const d = deps({ zoom: jest.fn(async () => zoomed) })
    const found = await findScreenTextWith(d, { state, query: "Submit" })
    expect(d.screenshot).not.toHaveBeenCalled()
    expect(d.zoom).toHaveBeenCalledWith(
      state,
      { x: 0, y: 0, width: 800, height: 600 },
      { surface: "computerUse" }
    )
    expect(found.matches[0].center).toEqual({ x: 15, y: 13 })
    expect(found.capture.coordinateSpace).toBe("screenshotPixels")
  })
  it("delivers through the canonical revision/token gate and preserves button/count", async () => {
    const performAction = jest.fn(async () => ({ status: "delivered" })) as unknown as NonNullable<
      OcrClickDeps["performAction"]
    >
    const d = deps({ zoom: jest.fn(async () => zoomed), performAction })
    await clickScreenTextWith(d, { state, query: "Submit", button: "right", doubleClick: true })
    expect(d.click).not.toHaveBeenCalled()
    expect(performAction).toHaveBeenCalledWith(
      expect.objectContaining({
        turnToken: "single-use",
        strategy: "pixel",
        action: { kind: "click", button: "right", count: 2 },
        target: {
          kind: "pixel",
          target: {
            sessionId: "app",
            lineageId: "line",
            revision: 7,
            point: { x: 15, y: 13 },
            screenshotWidth: 800,
            screenshotHeight: 600,
          },
        },
      }),
      { surface: "computerUse", clickX: 15, clickY: 13 }
    )
  })
  it("matches native negative-origin rounding for forbidden-region policy", async () => {
    const small = { ...state, surface: { pixelWidth: 1280, pixelHeight: 800 } }
    const zoom = {
      ...zoomed,
      surface: {
        ...zoomed.surface,
        ...small.surface,
        logicalBounds: { x: -1920, y: 0, width: 1920, height: 1200 },
      },
      screenshot: shot({ width: 1280, height: 800 }),
      region: { x: 0, y: 0, width: 1280, height: 800 },
      scale: 1,
    }
    const performAction = jest.fn(async () => ({ status: "delivered" })) as unknown as NonNullable<
      OcrClickDeps["performAction"]
    >
    const d = deps({
      zoom: jest.fn(async () => zoom),
      performAction,
      extract: jest.fn(async () =>
        ocrResult([{ text: "X", bbox: { x: 0, y: 0, width: 2, height: 2 } }])
      ),
    })
    await clickScreenTextWith(d, { state: small, query: "X" })
    expect(performAction).toHaveBeenCalledWith(
      expect.objectContaining({
        target: expect.objectContaining({
          target: expect.objectContaining({ point: { x: 1, y: 1 } }),
        }),
      }),
      expect.objectContaining({ clickX: -1919, clickY: 2 })
    )
    const missing = deps({ zoom: jest.fn(async () => ({ ...zoomed, surface: undefined })) })
    await expect(findScreenTextWith(missing, { state })).rejects.toThrow(/geometry is missing/)
    expect(missing.screenshot).not.toHaveBeenCalled()
  })

  it("never falls back to a monitor after a stale frame or canonical action refusal", async () => {
    const d = deps({ zoom: jest.fn(async () => ({ ...zoomed, revision: 6 })) })
    await expect(findScreenTextWith(d, { state })).rejects.toThrow(/does not match/)
    expect(d.screenshot).not.toHaveBeenCalled()
    const refused = deps({
      zoom: jest.fn(async () => zoomed),
      performAction: jest.fn(async () => {
        throw new Error("stale revision")
      }),
    })
    await expect(clickScreenTextWith(refused, { state, query: "Submit" })).rejects.toThrow(
      "stale revision"
    )
    expect(refused.click).not.toHaveBeenCalled()
  })
})

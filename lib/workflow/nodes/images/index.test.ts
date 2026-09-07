/**
 * Mocked at the codec boundary rather than at the engine. jsdom has no real
 * canvas, so `encodePixelBuffer` cannot run here, and the pixel functions
 * themselves already have their own tests under `lib/images/`. What is worth
 * pinning here is what this module owns: which options reach the engine, what
 * the output carries, and where the bytes end up.
 */
const encodePixelBuffer = jest.fn(
  async (_b: unknown, _o?: unknown): Promise<{ bytes: Uint8Array; mediaType: string }> => ({
    bytes: new Uint8Array([1, 2, 3]),
    mediaType: "image/webp",
  })
)
jest.mock("@/lib/images/codec", () => ({
  encodePixelBuffer: (b: unknown, o?: unknown) => encodePixelBuffer(b, o),
  decodeBlobToPixelBuffer: jest.fn(),
}))

const transformBuffer = jest.fn((_b: unknown, _o?: unknown) => ({
  width: 50,
  height: 25,
  data: new Uint8ClampedArray(4),
}))
jest.mock("@/lib/images/transform", () => ({
  transformBuffer: (b: unknown, o?: unknown) => transformBuffer(b, o),
}))

const applyAdjustments = jest.fn((_b: unknown, _a?: unknown) => ({
  width: 100,
  height: 50,
  data: new Uint8ClampedArray(4),
}))
jest.mock("@/lib/images/adjust", () => ({
  applyAdjustments: (b: unknown, a?: unknown) => applyAdjustments(b, a),
}))

const resolveImageSource = jest.fn(async (_p: unknown, _k: string): Promise<unknown> => ({
  buffer: { width: 100, height: 50, data: new Uint8ClampedArray(4) },
  sourceMediaType: "image/jpeg",
}))
jest.mock("../shared/image-source", () => ({
  resolveImageSource: (p: unknown, k: string) => resolveImageSource(p, k),
  IMAGE_SOURCE_FIELDS: ["blobRef", "dataUrl", "imageBase64", "url"],
}))

const storeWorkflowBlob = jest.fn(async (_i: unknown): Promise<unknown> => ({
  blobRef: "cognia-workflow-blob:b1",
  mediaType: "image/webp",
  byteLength: 3,
  width: 50,
  height: 25,
}))
jest.mock("@/lib/workflow/blobs/store", () => ({
  storeWorkflowBlob: (i: unknown) => storeWorkflowBlob(i),
}))

const getActiveAccountId = jest.fn(() => "acc1")
jest.mock("@/lib/accounts/active-account-id", () => ({
  getActiveAccountId: () => getActiveAccountId(),
}))

jest.mock("@/lib/images/pixel-buffer", () => ({ hasTransparency: () => true }))

import "."
import { getExecutor } from "../registry"
import type { StepExecutionContext } from "@/types/workflow/visual"

function run(kind: string, params: Record<string, unknown>) {
  const executor = getExecutor(kind as never, 1)!
  return executor.execute({
    params,
    workflowId: "wf1",
    runId: "run1",
    stepId: "s1",
  } as unknown as StepExecutionContext)
}

beforeEach(() => {
  jest.clearAllMocks()
  getActiveAccountId.mockReturnValue("acc1")
})

describe("registration", () => {
  it.each([
    "action.image.info",
    "action.image.transform",
    "action.image.adjust",
    "action.image.convert",
  ])("registers %s", (kind) => {
    expect(getExecutor(kind as never, 1)).toBeDefined()
  })

  it("registers no separate resize, crop, rotate or flip node", () => {
    // They collapse into `transform`, because the engine takes all four in one
    // pass and four nodes would be four lossy re-encodes.
    for (const kind of ["resize", "crop", "rotate", "flip"]) {
      expect(getExecutor(`action.image.${kind}` as never, 1)).toBeUndefined()
    }
  })
})

describe("action.image.info", () => {
  it("reports dimensions without encoding anything", async () => {
    const out = (await run("action.image.info", { blobRef: "x" })).output as Record<string, unknown>
    expect(out).toMatchObject({
      width: 100,
      height: 50,
      aspectRatio: 2,
      hasTransparency: true,
      sourceMediaType: "image/jpeg",
      pixelCount: 5000,
    })
    expect(encodePixelBuffer).not.toHaveBeenCalled()
    expect(storeWorkflowBlob).not.toHaveBeenCalled()
  })
})

describe("action.image.transform", () => {
  it("composes crop, scale, rotate and flip into one engine call", async () => {
    await run("action.image.transform", {
      rotate: 90,
      scale: 0.5,
      flipHorizontal: true,
      cropX: 1,
      cropY: 2,
      cropWidth: 10,
      cropHeight: 20,
    })
    expect(transformBuffer).toHaveBeenCalledTimes(1)
    expect(transformBuffer.mock.calls[0][1]).toEqual({
      rotate: 90,
      scale: 0.5,
      flipHorizontal: true,
      cropRegion: { x: 1, y: 2, width: 10, height: 20 },
    })
  })

  it("refuses a crop origin with no size", async () => {
    await expect(run("action.image.transform", { cropX: 5 })).rejects.toThrow(
      /needs cropWidth and cropHeight/
    )
  })

  it("refuses a transform that would do nothing", async () => {
    await expect(run("action.image.transform", {})).rejects.toThrow(/requires at least one of/)
    expect(transformBuffer).not.toHaveBeenCalled()
  })

  it("puts the bytes in the blob store and returns a reference, never the bytes", async () => {
    const out = (await run("action.image.transform", { scale: 2 })).output as Record<
      string,
      unknown
    >
    expect(storeWorkflowBlob).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: "acc1", runId: "run1", stepId: "s1", width: 50 })
    )
    expect(out).toMatchObject({ blobRef: "cognia-workflow-blob:b1", byteLength: 3 })
    expect(JSON.stringify(out)).not.toContain("data:")
  })

  it("reports the format it actually got, not the one requested", async () => {
    // A runtime with no WebP encoder hands back a PNG, and an alpha-carrying
    // buffer overrides the request outright.
    encodePixelBuffer.mockResolvedValue({ bytes: new Uint8Array([9]), mediaType: "image/png" })
    const out = (await run("action.image.transform", { scale: 2, format: "webp" }))
      .output as Record<string, unknown>
    expect(storeWorkflowBlob.mock.calls[0][0]).toMatchObject({ mediaType: "image/png" })
    expect(out.requestedFormat).toBe("webp")
  })

  it("converts the author's 0-to-100 quality into the engine's 0-to-1", async () => {
    await run("action.image.transform", { scale: 2, quality: 80 })
    expect(encodePixelBuffer.mock.calls[0][1]).toMatchObject({ quality: 0.8 })
  })
})

describe("action.image.adjust", () => {
  it("passes only the sliders the author set", async () => {
    await run("action.image.adjust", { brightness: 10, blur: 4 })
    expect(applyAdjustments.mock.calls[0][1]).toEqual({ brightness: 10, blur: 4 })
  })

  it("refuses an adjustment with no sliders", async () => {
    await expect(run("action.image.adjust", {})).rejects.toThrow(/requires at least one of/)
    expect(applyAdjustments).not.toHaveBeenCalled()
  })

  it("names which sliders it applied", async () => {
    const out = (await run("action.image.adjust", { contrast: -5, hue: 30 })).output as {
      applied: string[]
    }
    expect(out.applied.sort()).toEqual(["contrast", "hue"])
  })
})

describe("action.image.convert", () => {
  it("re-encodes without transforming", async () => {
    await run("action.image.convert", { format: "png" })
    expect(transformBuffer).not.toHaveBeenCalled()
    expect(applyAdjustments).not.toHaveBeenCalled()
    expect(encodePixelBuffer).toHaveBeenCalledTimes(1)
  })
})

describe("no account", () => {
  it("says why there is nowhere to put the result", async () => {
    getActiveAccountId.mockReturnValue("")
    await expect(run("action.image.convert", {})).rejects.toThrow(/no unlocked account/)
  })
})

import { createPixelBuffer } from "@/lib/images/pixel-buffer"
import {
  SCENE_CANDIDATES_MAX,
  SCENE_CANDIDATES_MIN,
  SCENE_CUT_THRESHOLD,
  SIGNATURE_SIZE,
  formatVideoTimestamp,
  lumaSignature,
  pickSceneFrames,
  sceneCandidateCount,
  signatureDistance,
  uniformSampleTimes,
  type SceneCandidate,
} from "./timeline"

function solid(width: number, height: number, rgba: [number, number, number, number]) {
  const buffer = createPixelBuffer(width, height)
  for (let i = 0; i < buffer.data.length; i += 4) buffer.data.set(rgba, i)
  return buffer
}

function flatSignature(value: number): Uint8Array {
  return new Uint8Array(SIGNATURE_SIZE * SIGNATURE_SIZE).fill(value)
}

describe("uniformSampleTimes", () => {
  it("places each sample at the middle of its slice", () => {
    expect(uniformSampleTimes({ startSec: 0, endSec: 10 }, 5)).toEqual([1, 3, 5, 7, 9])
    expect(uniformSampleTimes({ startSec: 20, endSec: 24 }, 2)).toEqual([21, 23])
  })

  it("degrades to one sample for an empty range or a nonsense count", () => {
    expect(uniformSampleTimes({ startSec: 3, endSec: 3 }, 9)).toEqual([3])
    expect(uniformSampleTimes({ startSec: 0, endSec: 4 }, 0)).toEqual([2])
  })
})

describe("sceneCandidateCount", () => {
  it("scales with the request inside fixed bounds", () => {
    expect(sceneCandidateCount(1)).toBe(SCENE_CANDIDATES_MIN)
    expect(sceneCandidateCount(9)).toBe(36)
    expect(sceneCandidateCount(1000)).toBe(SCENE_CANDIDATES_MAX)
  })
})

describe("lumaSignature", () => {
  it("averages luma per cell and weighs it by coverage", () => {
    const white = lumaSignature(solid(64, 64, [255, 255, 255, 255]))
    expect(white).toHaveLength(SIGNATURE_SIZE * SIGNATURE_SIZE)
    expect([...new Set(white)]).toEqual([255])
    const clear = lumaSignature(solid(64, 64, [255, 255, 255, 0]))
    expect([...new Set(clear)]).toEqual([0])
  })

  it("handles an image smaller than the signature", () => {
    const tiny = lumaSignature(solid(3, 2, [0, 255, 0, 255]))
    expect(tiny.every((v) => v === Math.round(0.587 * 255))).toBe(true)
  })

  it("separates a left/right split into distinct halves", () => {
    const buffer = solid(32, 32, [0, 0, 0, 255])
    for (let y = 0; y < 32; y++) {
      for (let x = 16; x < 32; x++) buffer.data.set([255, 255, 255, 255], (y * 32 + x) * 4)
    }
    const sig = lumaSignature(buffer)
    expect(sig[0]).toBe(0)
    expect(sig[SIGNATURE_SIZE - 1]).toBe(255)
  })
})

describe("signatureDistance", () => {
  it("is the mean absolute difference", () => {
    expect(signatureDistance(flatSignature(10), flatSignature(40))).toBe(30)
    expect(signatureDistance(new Uint8Array(), new Uint8Array())).toBe(0)
  })
})

describe("pickSceneFrames", () => {
  const at = (values: number[]): SceneCandidate[] =>
    values.map((v, i) => ({ timeSec: i, signature: flatSignature(v) }))

  it("takes the start plus the strongest cuts, in time order", () => {
    // Cuts at 4 (Δ100), 8 (Δ60), 12 (Δ30); small drift elsewhere.
    const candidates = at([10, 11, 12, 13, 113, 114, 115, 116, 56, 57, 58, 59, 29, 30, 31, 32])
    expect(pickSceneFrames(candidates, 3)).toEqual([
      { index: 0, reason: "start" },
      { index: 4, reason: "scene" },
      { index: 8, reason: "scene" },
    ])
  })

  it("skips a cut too close to one already taken", () => {
    // Two strong cuts back to back at 5 and 6, one weaker cut at 12.
    const values = [0, 0, 0, 0, 0, 200, 0, 0, 0, 0, 0, 0, 80, 80, 80, 80]
    const picked = pickSceneFrames(at(values), 3).map((p) => p.index)
    expect(picked).toContain(12)
    expect(picked.filter((i) => i === 5 || i === 6)).toHaveLength(1)
  })

  it("labels evenly spaced fills as uniform when the clip has no cuts", () => {
    const flat = at(new Array(16).fill(50).map((v, i) => v + (i % 2)))
    const picked = pickSceneFrames(flat, 4)
    expect(picked).toHaveLength(4)
    expect(picked[0]).toEqual({ index: 0, reason: "start" })
    expect(picked.slice(1).every((p) => p.reason === "uniform")).toBe(true)
    expect(new Set(picked.map((p) => p.index)).size).toBe(4)
  })

  it("never asks for more frames than there are candidates", () => {
    expect(pickSceneFrames(at([0, 100, 0]), 9)).toHaveLength(3)
    expect(pickSceneFrames([], 4)).toEqual([])
  })

  it("does not treat drift below the threshold as a cut", () => {
    const ramp = at(Array.from({ length: 16 }, (_, i) => i * (SCENE_CUT_THRESHOLD - 1)))
    expect(pickSceneFrames(ramp, 3).filter((p) => p.reason === "scene")).toEqual([])
  })
})

describe("formatVideoTimestamp", () => {
  it("writes m:ss and h:mm:ss", () => {
    expect(formatVideoTimestamp(0)).toBe("0:00")
    expect(formatVideoTimestamp(65.4)).toBe("1:05")
    expect(formatVideoTimestamp(3725)).toBe("1:02:05")
  })

  it("adds tenths when asked, without rounding into the next second", () => {
    expect(formatVideoTimestamp(2.46, true)).toBe("0:02.5")
    expect(formatVideoTimestamp(59.96, true)).toBe("1:00.0")
    expect(formatVideoTimestamp(0.04, true)).toBe("0:00.0")
  })

  it("treats a negative or non-finite value as zero", () => {
    expect(formatVideoTimestamp(-3)).toBe("0:00")
    expect(formatVideoTimestamp(Number.NaN, true)).toBe("0:00.0")
  })
})

import { buildBlindAssignments } from "./judging"
import { createChainedSeededRandom, createSeededRandom } from "./seeded-random"
import { bootstrapMean, pairedBootstrap } from "./statistics"
import { seededShuffle } from "./routing/grouped-split"

/**
 * Pinned streams. These values were captured from the original private
 * implementations before the generators were centralized here; a change to
 * any of them silently rewires every seeded procedure in the package
 * (bootstrap intervals, calibration draws, blind A/B orientation).
 */
describe("createSeededRandom (mulberry32)", () => {
  it("replays the pinned stream for a seed", () => {
    expect(Array.from({ length: 5 }, createSeededRandom(0))).toEqual([
      0.26642920868471265, 0.0003297457005828619, 0.2232720274478197, 0.1462021479383111,
      0.46732782293111086,
    ])
    expect(Array.from({ length: 5 }, createSeededRandom(1))).toEqual([
      0.6270739405881613, 0.002735721180215478, 0.5274470399599522, 0.9810509674716741,
      0.9683778982143849,
    ])
    expect(Array.from({ length: 5 }, createSeededRandom(42))).toEqual([
      0.6011037519201636, 0.44829055899754167, 0.8524657934904099, 0.6697340414393693,
      0.17481389874592423,
    ])
  })

  it("masks the seed to 32 bits", () => {
    expect(createSeededRandom(0x100000001)()).toBe(createSeededRandom(1)())
  })
})

describe("createChainedSeededRandom (blind judging variant)", () => {
  it("replays the pinned stream for a seed — a different stream than mulberry32", () => {
    expect(Array.from({ length: 5 }, createChainedSeededRandom(1))).toEqual([
      1.4668330550193787e-8, 0.003751125419512391, 0.8805436776019633, 0.04294334910809994,
      0.38185202865861356,
    ])
    expect(Array.from({ length: 5 }, createChainedSeededRandom(42))).toEqual([
      0.0007748480420559645, 0.2783796479925513, 0.18123744847252965, 0.6349591782782227,
      0.025311013218015432,
    ])
  })

  it("pins the seed-0 fixed point so it stays a documented caveat", () => {
    expect(Array.from({ length: 3 }, createChainedSeededRandom(0))).toEqual([0, 0, 0])
  })
})

describe("pinned call-site outputs", () => {
  it("keeps the Fisher–Yates shuffle order for a seed", () => {
    expect(seededShuffle(["a", "b", "c", "d", "e", "f"], 11)).toEqual([
      "a",
      "f",
      "b",
      "e",
      "c",
      "d",
    ])
    expect(seededShuffle(["A", "B", "C", "D", "F", "G", "H"], 42)).toEqual([
      "D",
      "B",
      "A",
      "G",
      "H",
      "C",
      "F",
    ])
  })

  it("keeps bootstrap intervals bit-identical", () => {
    expect(
      pairedBootstrap([0.9, 0.8, 0.7, 0.95, 0.85], [0.4, 0.5, 0.45, 0.6, 0.55], {
        seed: 42,
        iterations: 2_000,
      })
    ).toEqual({
      meanDifference: 0.33999999999999997,
      low: 0.2799999999999999,
      high: 0.43,
      confidenceLevel: 0.95,
      separated: true,
      sampleSize: 5,
    })
    expect(bootstrapMean([1, 0, 1, 1, 0], { seed: 17, iterations: 2_000 })).toEqual({
      mean: 0.6,
      low: 0.2,
      high: 1,
      confidenceLevel: 0.95,
      sampleSize: 5,
    })
  })

  it("keeps blind A/B orientation bit-identical", () => {
    const pairs = Array.from({ length: 12 }, (_, index) => ({
      pairId: `pair-${index}`,
      first: { variantId: "variant-a", sampleId: `a-${index}`, output: `A ${index}` },
      second: { variantId: "variant-b", sampleId: `b-${index}`, output: `B ${index}` },
    }))
    const { publicAssignments, privateMapping } = buildBlindAssignments(pairs, 42)
    expect(publicAssignments.map((assignment) => assignment.left.sampleId)).toEqual([
      "a-0",
      "a-1",
      "a-2",
      "b-3",
      "a-4",
      "a-5",
      "a-6",
      "b-7",
      "a-8",
      "b-9",
      "b-10",
      "a-11",
    ])
    expect(privateMapping["blind-16-3"]).toEqual({
      leftVariantId: "variant-b",
      rightVariantId: "variant-a",
    })
    expect(
      buildBlindAssignments(pairs.slice(0, 6), 7).publicAssignments.map(
        (assignment) => assignment.left.sampleId
      )
    ).toEqual(["a-0", "a-1", "a-2", "a-3", "a-4", "b-5"])
  })
})

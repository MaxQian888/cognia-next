import { STEER_PREFIX, frameSteer, frameSteerQueue } from "./steer"

describe("frameSteer", () => {
  it("prefixes and trims a single message", () => {
    expect(frameSteer("  use TypeScript  ")).toBe(`${STEER_PREFIX}use TypeScript`)
  })

  it("frames an empty string as the bare prefix", () => {
    expect(frameSteer("")).toBe(STEER_PREFIX)
  })
})

describe("frameSteerQueue", () => {
  it("joins multiple entries most-recent last with blank-line separators", () => {
    expect(frameSteerQueue(["first", "second"])).toBe(`${STEER_PREFIX}first\n\nsecond`)
  })

  it("trims and drops blank entries", () => {
    expect(frameSteerQueue(["  a  ", "   ", "b"])).toBe(`${STEER_PREFIX}a\n\nb`)
  })

  it("collapses an all-blank queue to the bare prefix", () => {
    expect(frameSteerQueue(["  ", ""])).toBe(STEER_PREFIX)
  })

  it("handles a single entry", () => {
    expect(frameSteerQueue(["only"])).toBe(`${STEER_PREFIX}only`)
  })
})

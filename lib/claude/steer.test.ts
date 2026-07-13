import {
  STEER_PREFIX,
  buildSteerPayload,
  frameSteer,
  frameSteerQueue,
  steerBlocksOf,
  steerTextOf,
} from "./steer"
import type { SendContentBlock } from "@cognia/agent-config-types"

const img = (data: string): SendContentBlock => ({
  type: "image",
  source: { type: "base64", media_type: "image/png", data },
})

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

describe("steerTextOf", () => {
  it("trims a plain string send", () => {
    expect(steerTextOf("  hello  ")).toBe("hello")
  })

  it("reads the first text block of a block array", () => {
    expect(steerTextOf([img("AAAA"), { type: "text", text: " do it " }])).toBe("do it")
  })

  it("is empty when there is no text block", () => {
    expect(steerTextOf([img("AAAA")])).toBe("")
  })
})

describe("steerBlocksOf", () => {
  it("is empty for a plain string", () => {
    expect(steerBlocksOf("hi")).toEqual([])
  })

  it("returns only the non-text blocks", () => {
    const image = img("AAAA")
    expect(steerBlocksOf([image, { type: "text", text: "x" }])).toEqual([image])
  })
})

describe("buildSteerPayload", () => {
  it("returns a plain framed string when no entry carries blocks", () => {
    expect(buildSteerPayload([{ text: "a" }, { text: "b" }])).toBe(`${STEER_PREFIX}a\n\nb`)
  })

  it("aggregates every entry's blocks ahead of one framed text block", () => {
    const a = img("AAAA")
    const b = img("BBBB")
    expect(
      buildSteerPayload([
        { text: "first", blocks: [a] },
        { text: "second", blocks: [b] },
      ])
    ).toEqual([a, b, { type: "text", text: `${STEER_PREFIX}first\n\nsecond` }])
  })
})

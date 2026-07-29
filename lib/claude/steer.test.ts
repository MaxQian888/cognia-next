import {
  STEER_PREFIX,
  buildSteerPayload,
  frameSteer,
  frameSteerQueue,
  resolveSteerDisplayState,
  steerBlocksOf,
  steerMetaOf,
  steerTextOf,
  stripSteerPrefix,
  type SteerMessageMeta,
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

describe("stripSteerPrefix", () => {
  it("removes the model-facing framing so the user reads their own words", () => {
    expect(stripSteerPrefix(`${STEER_PREFIX}use TypeScript`)).toBe("use TypeScript")
  })

  it("leaves unframed text alone", () => {
    expect(stripSteerPrefix("use TypeScript")).toBe("use TypeScript")
  })

  it("only strips a leading occurrence", () => {
    expect(stripSteerPrefix(`talk about ${STEER_PREFIX}later`)).toBe(
      `talk about ${STEER_PREFIX}later`
    )
  })
})

describe("steerMetaOf", () => {
  it("reads well-formed steer metadata", () => {
    expect(steerMetaOf({ steer: { entryId: "e1", state: "queued" } })).toEqual({
      entryId: "e1",
      state: "queued",
    })
  })

  it("returns null for anything that is not steer metadata", () => {
    expect(steerMetaOf(undefined)).toBeNull()
    expect(steerMetaOf(null)).toBeNull()
    expect(steerMetaOf("nope")).toBeNull()
    expect(steerMetaOf({})).toBeNull()
    expect(steerMetaOf({ steer: null })).toBeNull()
    // Partial shapes must not pass — the renderer switches on `state`.
    expect(steerMetaOf({ steer: { entryId: "e1" } })).toBeNull()
    expect(steerMetaOf({ steer: { state: "queued" } })).toBeNull()
  })
})

describe("resolveSteerDisplayState", () => {
  const meta = (state: SteerMessageMeta["state"]): SteerMessageMeta => ({ entryId: "e1", state })

  it("passes terminal states through untouched", () => {
    expect(
      resolveSteerDisplayState(meta("applied"), { sessionBusy: true, stillQueued: true })
    ).toBe("applied")
    expect(resolveSteerDisplayState(meta("failed"), { sessionBusy: true, stillQueued: true })).toBe(
      "failed"
    )
  })

  it("keeps an accepted steer pending only while the turn is still running", () => {
    expect(
      resolveSteerDisplayState(meta("accepted"), { sessionBusy: true, stillQueued: false })
    ).toBe("accepted")
    // Idle means that turn ended (including via a restart); the sidecar had
    // taken it, so the model saw it.
    expect(
      resolveSteerDisplayState(meta("accepted"), { sessionBusy: false, stillQueued: false })
    ).toBe("applied")
  })

  it("keeps a queued steer waiting only while it can still be delivered", () => {
    expect(resolveSteerDisplayState(meta("queued"), { sessionBusy: true, stillQueued: true })).toBe(
      "queued"
    )
  })

  it("fails a queued steer once no settle can deliver it", () => {
    // Run ended without draining.
    expect(
      resolveSteerDisplayState(meta("queued"), { sessionBusy: false, stillQueued: true })
    ).toBe("failed")
    // After a restart the memory-only queue is empty, so nothing is left to
    // deliver it — this is the reload case.
    expect(
      resolveSteerDisplayState(meta("queued"), { sessionBusy: false, stillQueued: false })
    ).toBe("failed")
    expect(
      resolveSteerDisplayState(meta("queued"), { sessionBusy: true, stillQueued: false })
    ).toBe("failed")
  })
})

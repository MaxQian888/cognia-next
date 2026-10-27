import { readFileSync } from "node:fs"
import { join } from "node:path"

import {
  applyTranscriptLiveFrame,
  createTranscriptLiveEncoder,
  isTranscriptLiveFrame,
  TRANSCRIPT_LIVE_FRAME_MAX_BYTES,
  TRANSCRIPT_LIVE_KEYFRAME_MS,
  type TranscriptLiveFrame,
  type TranscriptLivePart,
  type TranscriptLiveTurn,
} from "./live-frames"

const text = (value: string): TranscriptLivePart =>
  ({ type: "text", text: value }) as TranscriptLivePart

function encoder(options: { maxBytes?: number } = {}) {
  let now = 0
  const encode = createTranscriptLiveEncoder({
    sessionId: "s1",
    messageId: "assistant-a1",
    replyTo: "u1",
    now: () => now,
    ...options,
  })
  return { encode, advance: (ms: number) => (now += ms) }
}

/** Fold frames the way a device does. */
function draw(frames: Array<TranscriptLiveFrame | null>, start: TranscriptLiveTurn | null = null) {
  return frames.reduce<TranscriptLiveTurn | null>(
    (turn, frame) => (frame ? applyTranscriptLiveFrame(turn, frame) : turn),
    start
  )
}

describe("isTranscriptLiveFrame", () => {
  const frame = {
    sessionId: "s1",
    messageId: "m",
    replyTo: "u",
    seq: 2,
    base: 1,
    keyframe: false,
    state: "streaming",
    parts: [{ type: "text", text: "x" }],
  }

  it("p6e accepts the shape the Host admits and nothing looser", () => {
    expect(isTranscriptLiveFrame(frame)).toBe(true)
    for (const bad of [
      null,
      { ...frame, sessionId: "" },
      { ...frame, replyTo: undefined },
      { ...frame, seq: 0 },
      { ...frame, base: -1 },
      { ...frame, base: 1.5 },
      { ...frame, state: "done" },
      { ...frame, parts: ["x"] },
      { ...frame, parts: [[]] },
      { ...frame, keyframe: true },
      { ...frame, state: "settled" },
      { ...frame, state: "reset", keyframe: true, base: 0 },
      // Only the final frame names the revision it precedes.
      { ...frame, afterRevision: 3 },
      { ...frame, state: "settled", keyframe: true, base: 0, afterRevision: -1 },
    ]) {
      expect(isTranscriptLiveFrame(bad)).toBe(false)
    }
  })
})

describe("createTranscriptLiveEncoder", () => {
  it("p6e sends the first frame whole, then only the parts that changed", () => {
    const { encode } = encoder()
    const first = [text("a")]
    expect(encode.next(first)).toEqual({
      sessionId: "s1",
      messageId: "assistant-a1",
      replyTo: "u1",
      seq: 1,
      base: 0,
      keyframe: true,
      state: "streaming",
      parts: first,
    })
    // Nothing moved: nothing to send.
    expect(encode.next(first)).toBeNull()
    const grown = [first[0]!, text("b")]
    expect(encode.next(grown)).toEqual(
      expect.objectContaining({ seq: 2, base: 1, keyframe: false, parts: [grown[1]] })
    )
    // A replaced part in the middle resends from there.
    const replaced = [text("A"), grown[1]!]
    expect(encode.next(replaced)).toEqual(
      expect.objectContaining({ seq: 3, base: 0, keyframe: false, parts: replaced })
    )
  })

  it("p6e resends the whole reply on a cadence and when it settles", () => {
    const { encode, advance } = encoder()
    const one = [text("a")]
    encode.next(one)
    advance(TRANSCRIPT_LIVE_KEYFRAME_MS)
    const two = [one[0]!, text("b")]
    expect(encode.next(two)).toEqual(
      expect.objectContaining({ keyframe: true, base: 0, parts: two })
    )
    const settled = encode.next(two, "settled", 5)
    expect(settled).toEqual(
      expect.objectContaining({
        keyframe: true,
        base: 0,
        state: "settled",
        parts: two,
        afterRevision: 5,
      })
    )
    expect(isTranscriptLiveFrame(settled)).toBe(true)
    expect(applyTranscriptLiveFrame(null, settled!)?.afterRevision).toBe(5)
  })

  it("p6e stops drawing a reply too large to send and resumes when a keyframe fits", () => {
    const { encode, advance } = encoder({ maxBytes: 400 })
    encode.next([text("a")])
    const huge = [text("x".repeat(500))]
    expect(encode.next(huge)).toEqual(
      expect.objectContaining({ seq: 2, state: "reset", parts: [], keyframe: true })
    )
    // Still too large, and not due: silent rather than another reset.
    advance(100)
    expect(encode.next(huge)).toBeNull()
    advance(TRANSCRIPT_LIVE_KEYFRAME_MS)
    expect(encode.next(huge)).toBeNull()
    advance(TRANSCRIPT_LIVE_KEYFRAME_MS)
    const small = [text("ok")]
    expect(encode.next(small)).toEqual(
      expect.objectContaining({ seq: 3, keyframe: true, state: "streaming", parts: small })
    )
  })

  it("p6e resets only a reply it has started", () => {
    const { encode } = encoder()
    expect(encode.reset()).toBeNull()
    encode.next([text("a")])
    expect(encode.reset()).toEqual(expect.objectContaining({ state: "reset", seq: 2 }))
  })
})

describe("applyTranscriptLiveFrame", () => {
  it("p6e rebuilds what the brain sent, frame by frame", () => {
    const { encode } = encoder()
    const a = text("a")
    const b = text("b")
    const turn = draw([encode.next([a]), encode.next([a, b]), encode.next([a, b], "settled")])
    expect(turn).toEqual({
      sessionId: "s1",
      messageId: "assistant-a1",
      replyTo: "u1",
      seq: 3,
      parts: [a, b],
      state: "settled",
      stale: false,
    })
  })

  it("p6e holds the last good reply over a missing frame until a keyframe", () => {
    const { encode, advance } = encoder()
    const a = text("a")
    const frames = [encode.next([a]), encode.next([a, text("b")]), encode.next([a, text("c")])]
    const gap = draw([frames[0]!, frames[2]!])
    expect(gap?.stale).toBe(true)
    expect(gap?.parts).toEqual([a])
    // A late patch never draws over a stale reply.
    expect(applyTranscriptLiveFrame(gap, { ...frames[2]!, seq: 4 })).toBe(gap)
    advance(TRANSCRIPT_LIVE_KEYFRAME_MS)
    const caught = applyTranscriptLiveFrame(gap, encode.next([a, text("d")])!)
    expect(caught).toEqual(expect.objectContaining({ stale: false, parts: [a, text("d")] }))
  })

  it("p6e joins late only at a keyframe and ignores replays and old frames", () => {
    const { encode } = encoder()
    const a = text("a")
    const first = encode.next([a])!
    const patch = encode.next([a, text("b")])!
    expect(applyTranscriptLiveFrame(null, patch)).toBeNull()
    const turn = applyTranscriptLiveFrame(null, first)
    expect(applyTranscriptLiveFrame(turn, first)).toBe(turn)
  })

  it("p6e drops the reply on reset, and a new reply replaces a settled one at its keyframe", () => {
    const { encode } = encoder()
    const turn = draw([encode.next([text("a")])])
    expect(applyTranscriptLiveFrame(turn, encode.reset()!)).toBeNull()

    const settled = draw([encode.next([text("a")], "settled")])
    const next = createTranscriptLiveEncoder({
      sessionId: "s1",
      messageId: "assistant-a2",
      replyTo: "u2",
      now: () => 0,
    })
    const nextFirst = next.next([text("z")])!
    // A patch of the next reply cannot be drawn yet; the settled one stays.
    expect(
      applyTranscriptLiveFrame(settled, { ...nextFirst, seq: 2, base: 1, keyframe: false })
    ).toBe(settled)
    expect(applyTranscriptLiveFrame(settled, nextFirst)?.messageId).toBe("assistant-a2")
    // Another reply's reset leaves this one alone.
    expect(applyTranscriptLiveFrame(settled, { ...nextFirst, state: "reset", parts: [] })).toBe(
      settled
    )
  })
})

describe("the shared live-frame contract (protocol/transcript-live-frame-v1.json)", () => {
  // The one fixture the Host bridge, the collaboration server and this codec
  // are each checked against, so their admission rules cannot drift apart.
  const contract = JSON.parse(
    readFileSync(join(process.cwd(), "protocol/transcript-live-frame-v1.json"), "utf8")
  ) as {
    maxIdLength: number
    maxFrameBytes: number
    valid: unknown[]
    invalid: Array<{ why: string; frame: unknown }>
  }
  const admitted = (frame: unknown) =>
    isTranscriptLiveFrame(frame) &&
    new TextEncoder().encode(JSON.stringify(frame)).length <= contract.maxFrameBytes

  it("pins the same budget as the encoder", () => {
    expect(contract.maxFrameBytes).toBe(TRANSCRIPT_LIVE_FRAME_MAX_BYTES)
    expect(contract.maxIdLength).toBe(256)
  })

  it.each(contract.valid.map((frame, index) => [index, frame]))(
    "admits valid frame %i",
    (_, frame) => {
      expect(admitted(frame)).toBe(true)
    }
  )

  it.each(contract.invalid.map(({ why, frame }) => [why, frame]))("refuses %s", (_, frame) => {
    expect(admitted(frame)).toBe(false)
  })
})

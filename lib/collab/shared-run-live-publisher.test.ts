import type { TranscriptLiveFrame, TranscriptLivePart } from "@/lib/chat/transcript/live-frames"
import { CollabConflictError, CollabError } from "./client"
import { createSharedRunLivePublisher } from "./shared-run-live-publisher"

const A = { messageId: "a", replyTo: "u" }
const B = { messageId: "b", replyTo: "u" }
const text = (value: string) => ({ type: "text", text: value }) as TranscriptLivePart

function harness(post?: (frame: TranscriptLiveFrame) => Promise<void>) {
  const frames: TranscriptLiveFrame[] = []
  let clock = 0
  const onToolDetailStale = jest.fn()
  const onRedacted = jest.fn()
  const publisher = createSharedRunLivePublisher({
    sessionId: "ses",
    now: () => clock,
    post: async (frame) => {
      frames.push(frame)
      await post?.(frame)
    },
    onToolDetailStale,
    onRedacted,
  })
  return {
    publisher,
    frames,
    onToolDetailStale,
    onRedacted,
    tick: (ms: number) => {
      clock += ms
    },
  }
}

it("streams a keyframe, then patches, then a settled keyframe with the revision", async () => {
  const { publisher, frames, tick } = harness()
  const one = text("one")
  await publisher.stream(A, [one])
  tick(250)
  await publisher.stream(A, [one, text("two")])
  tick(250)
  await publisher.settle(A, [one, text("two!")], 41)
  expect(frames.map(({ seq, base, keyframe, state }) => ({ seq, base, keyframe, state }))).toEqual([
    { seq: 1, base: 0, keyframe: true, state: "streaming" },
    { seq: 2, base: 1, keyframe: false, state: "streaming" },
    { seq: 3, base: 0, keyframe: true, state: "settled" },
  ])
  expect(frames[2]!.afterRevision).toBe(41)
  expect(frames[0]).toMatchObject({ sessionId: "ses", messageId: "a", replyTo: "u" })
})

it("skips a streaming tick while a POST is in flight but always sends the settle", async () => {
  let release!: () => void
  let first = true
  const { publisher, frames } = harness(
    () =>
      new Promise<void>((resolve) => {
        if (!first) return resolve()
        first = false
        release = resolve
      })
  )
  const pending = publisher.stream(A, [text("one")])
  await publisher.stream(A, [text("one two")])
  expect(frames).toHaveLength(1)
  const settling = publisher.settle(A, [text("one two three")])
  release()
  await Promise.all([pending, settling])
  expect(frames.map((frame) => frame.state)).toEqual(["streaming", "settled"])
  // The skipped tick left no gap: the settle follows the first frame directly.
  expect(frames.map((frame) => frame.seq)).toEqual([1, 2])
})

it("never sends again for a reply that ended", async () => {
  const { publisher, frames } = harness()
  await publisher.stream(A, [text("a")])
  await publisher.settle(A, [text("a!")])
  await publisher.stream(B, [text("b")])
  // A delayed tick for A after B started is refused.
  await publisher.stream(A, [text("a again")])
  await publisher.settle(A, [text("a again")])
  expect(frames.map((frame) => [frame.messageId, frame.state])).toEqual([
    ["a", "streaming"],
    ["a", "settled"],
    ["b", "streaming"],
  ])
  expect(publisher.ended("a")).toBe(true)
  expect(publisher.current).toBe("b")
})

it("ends the previous reply when a newer one starts", async () => {
  const { publisher } = harness()
  await publisher.stream(A, [text("a")])
  await publisher.stream(B, [text("b")])
  expect(publisher.ended("a")).toBe(true)
})

it("resets a reply that streamed and ignores one that never did", async () => {
  const { publisher, frames } = harness()
  await publisher.reset("never")
  await publisher.stream(A, [text("a")])
  await publisher.reset("a")
  expect(frames.map((frame) => frame.state)).toEqual(["streaming", "reset"])
  expect(publisher.ended("never")).toBe(true)
})

it("drops a frame on 429, 5xx or a network error and keeps streaming", async () => {
  const errors = [new CollabError(429, "slow"), new CollabError(503, "down"), new TypeError("x")]
  const { publisher, frames, tick } = harness(async () => {
    const error = errors.shift()
    if (error) throw error
  })
  for (const value of ["a", "ab", "abc", "abcd"]) {
    tick(250)
    await publisher.stream(A, [text(value)])
  }
  expect(frames).toHaveLength(4)
  expect(publisher.disabled).toBe(false)
})

it("turns live off for the run on another 4xx, without throwing", async () => {
  const { publisher, frames } = harness(async () => {
    throw new CollabError(403, "no")
  })
  await expect(publisher.stream(A, [text("a")])).resolves.toBeUndefined()
  await publisher.stream(A, [text("ab")])
  await publisher.settle(A, [text("abc")])
  expect(frames).toHaveLength(1)
  expect(publisher.disabled).toBe(true)
})

it("asks for the tool-detail tier again on a stale revision", async () => {
  const { publisher, onToolDetailStale } = harness(async () => {
    throw new CollabConflictError("stale", { reason: "tool_detail_stale" })
  })
  await publisher.stream(A, [text("a")])
  expect(onToolDetailStale).toHaveBeenCalledTimes(1)
  expect(publisher.disabled).toBe(false)
})

it("ends a reply a member redacted", async () => {
  const { publisher, frames, onRedacted } = harness(async () => {
    throw new CollabConflictError("redacted", { reason: "message_redacted" })
  })
  await publisher.stream(A, [text("a")])
  await publisher.stream(A, [text("ab")])
  expect(onRedacted).toHaveBeenCalledWith("a")
  expect(frames).toHaveLength(1)
  expect(publisher.ended("a")).toBe(true)
})

it("sends nothing after stop", async () => {
  const { publisher, frames } = harness()
  publisher.stop()
  await publisher.stream(A, [text("a")])
  await publisher.settle(A, [text("a")])
  expect(frames).toEqual([])
})

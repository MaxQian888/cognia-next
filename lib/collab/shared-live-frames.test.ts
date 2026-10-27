import type { TranscriptLiveFrame } from "@/lib/chat/transcript/live-frames"
import {
  endSharedLive,
  noteSharedLiveEvent,
  noteSharedLivePull,
  publishSharedLiveFrame,
  resetSharedLiveForTesting,
  SHARED_LIVE_SILENCE_MS,
  subscribeSharedLive,
} from "./shared-live-frames"

const S = "shared"

function frame(overrides: Partial<TranscriptLiveFrame> = {}): TranscriptLiveFrame {
  return {
    sessionId: S,
    messageId: "a",
    replyTo: "u",
    seq: 1,
    base: 0,
    keyframe: true,
    state: "streaming",
    parts: [{ type: "text", text: "hi" }],
    ...overrides,
  }
}

function listen() {
  const seen: TranscriptLiveFrame[] = []
  const stop = subscribeSharedLive(S, (value) => seen.push(value))
  return { seen, stop, states: () => seen.map((value) => [value.messageId, value.state]) }
}

beforeEach(() => {
  jest.useFakeTimers()
  resetSharedLiveForTesting()
})
afterEach(() => jest.useRealTimers())

it("relays frames for its own session only", () => {
  const { states } = listen()
  publishSharedLiveFrame(S, frame())
  publishSharedLiveFrame(S, frame({ sessionId: "other" }))
  expect(states()).toEqual([["a", "streaming"]])
})

it("resets a streaming reply after six silent seconds, and refuses it afterwards", () => {
  const { states } = listen()
  publishSharedLiveFrame(S, frame())
  jest.advanceTimersByTime(SHARED_LIVE_SILENCE_MS - 1)
  publishSharedLiveFrame(S, frame({ seq: 2, keyframe: false, base: 1, parts: [] }))
  jest.advanceTimersByTime(SHARED_LIVE_SILENCE_MS - 1)
  expect(states()).toEqual([
    ["a", "streaming"],
    ["a", "streaming"],
  ])
  jest.advanceTimersByTime(1)
  expect(states().at(-1)).toEqual(["a", "reset"])
  publishSharedLiveFrame(S, frame({ seq: 9 }))
  expect(states()).toHaveLength(3)
})

it("resets the drawn reply on its redaction and refuses a late keyframe for it", () => {
  const { states } = listen()
  publishSharedLiveFrame(S, frame())
  noteSharedLiveEvent(S, { kind: "message.redacted", payload: { targetMessageId: "a" } })
  publishSharedLiveFrame(S, frame({ seq: 5 }))
  expect(states()).toEqual([
    ["a", "streaming"],
    ["a", "reset"],
  ])
})

it("refuses a keyframe for a reply redacted before it ever drew", () => {
  const { states } = listen()
  publishSharedLiveFrame(S, frame({ messageId: "b" }))
  noteSharedLiveEvent(S, { kind: "message.redacted", payload: { targetMessageId: "a" } })
  publishSharedLiveFrame(S, frame())
  expect(states()).toEqual([["b", "streaming"]])
})

it("keeps a settled reply after its run ends and refuses streaming until the next run", () => {
  const { states } = listen()
  publishSharedLiveFrame(S, frame())
  noteSharedLiveEvent(S, { kind: "run.completed", payload: {} })
  // The settle can still land after the terminal notice.
  publishSharedLiveFrame(S, frame({ seq: 2, state: "settled", afterRevision: 7 }))
  noteSharedLivePull(S, [])
  publishSharedLiveFrame(S, frame({ messageId: "b" }))
  noteSharedLiveEvent(S, { kind: "run.started", payload: {} })
  publishSharedLiveFrame(S, frame({ messageId: "b" }))
  expect(states()).toEqual([
    ["a", "streaming"],
    ["a", "settled"],
    ["b", "streaming"],
  ])
})

it("drops a reply still streaming when its run ended, once the next pull applied", () => {
  const { states } = listen()
  publishSharedLiveFrame(S, frame())
  noteSharedLiveEvent(S, { kind: "run.failed", payload: {} })
  expect(states()).toEqual([["a", "streaming"]])
  noteSharedLivePull(S, [])
  expect(states().at(-1)).toEqual(["a", "reset"])
})

it("learns from a reconnect's pull that a new run started while the socket was down", () => {
  const { states } = listen()
  publishSharedLiveFrame(S, frame({ state: "settled" }))
  noteSharedLiveEvent(S, { kind: "run.completed", payload: {} })
  noteSharedLivePull(S, [{ kind: "run.started", payload: {} }])
  publishSharedLiveFrame(S, frame({ messageId: "b" }))
  expect(states().at(-1)).toEqual(["b", "streaming"])
})

it("never redraws a reply that settled", () => {
  const { states } = listen()
  publishSharedLiveFrame(S, frame({ state: "settled" }))
  publishSharedLiveFrame(S, frame({ seq: 4 }))
  expect(states()).toEqual([["a", "settled"]])
})

it("ends the earlier reply when a newer one starts", () => {
  const { states } = listen()
  publishSharedLiveFrame(S, frame())
  publishSharedLiveFrame(S, frame({ messageId: "b" }))
  publishSharedLiveFrame(S, frame({ seq: 3 }))
  expect(states()).toEqual([
    ["a", "streaming"],
    ["b", "streaming"],
  ])
})

it("resets a streaming reply when the stream closes, but keeps a settled one", () => {
  const first = listen()
  publishSharedLiveFrame(S, frame())
  endSharedLive(S)
  expect(first.states().at(-1)).toEqual(["a", "reset"])
  publishSharedLiveFrame(S, frame({ messageId: "b", state: "settled" }))
  endSharedLive(S)
  expect(first.states().at(-1)).toEqual(["b", "settled"])
})

it("stops delivering after unsubscribe", () => {
  const { seen, stop } = listen()
  stop()
  publishSharedLiveFrame(S, frame())
  expect(seen).toEqual([])
})

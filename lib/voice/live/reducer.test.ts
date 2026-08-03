import type { Experimental_RealtimeModelV4ServerEvent as RealtimeServerEvent } from "@ai-sdk/provider"

import {
  createInitialLiveVoiceState,
  reduceLiveVoiceServerEvent,
  type LiveVoiceState,
} from "./reducer"

/** Build a server event with the `raw` field every variant carries. */
function event(partial: Record<string, unknown>): RealtimeServerEvent {
  return { raw: {}, ...partial } as RealtimeServerEvent
}

/** Fold a sequence of events over the initial state. */
function fold(...events: RealtimeServerEvent[]): LiveVoiceState {
  return events.reduce(reduceLiveVoiceServerEvent, createInitialLiveVoiceState())
}

describe("session lifecycle", () => {
  it("moves to listening once the session exists", () => {
    expect(fold(event({ type: "session-created", sessionId: "s1" })).phase).toBe("listening")
  })

  it("clears a previous error on session-updated", () => {
    const errored = fold(event({ type: "error", message: "boom" }))

    const recovered = reduceLiveVoiceServerEvent(errored, event({ type: "session-updated" }))

    expect(recovered.phase).toBe("listening")
    expect(recovered.error).toBeUndefined()
  })

  it("returns the same object when already listening and healthy", () => {
    const listening = fold(event({ type: "session-created" }))

    expect(reduceLiveVoiceServerEvent(listening, event({ type: "session-updated" }))).toBe(
      listening
    )
  })
})

describe("turn phases", () => {
  it("tracks the user speaking, thinking, responding, done cycle", () => {
    let state = fold(event({ type: "session-created" }))
    const phases: string[] = []

    for (const next of [
      event({ type: "speech-started" }),
      event({ type: "speech-stopped" }),
      event({ type: "response-created", responseId: "r1" }),
      event({ type: "response-done", responseId: "r1", status: "completed" }),
    ]) {
      state = reduceLiveVoiceServerEvent(state, next)
      phases.push(state.phase)
    }

    expect(phases).toEqual(["speaking", "thinking", "responding", "listening"])
  })

  it("drops the in-flight assistant draft on barge-in", () => {
    // The user talked over a partial reply; that text was never really said.
    const mid = fold(
      event({ type: "session-created" }),
      event({ type: "audio-transcript-delta", responseId: "r1", itemId: "a1", delta: "half a sen" })
    )

    const bargedIn = reduceLiveVoiceServerEvent(mid, event({ type: "speech-started" }))

    expect(bargedIn.assistantDraft).toBe("")
    expect(bargedIn.phase).toBe("speaking")
  })

  it("keeps completed turns across a barge-in", () => {
    const state = fold(
      event({ type: "input-transcription-completed", itemId: "u1", transcript: "hello" }),
      event({ type: "speech-started" })
    )

    expect(state.turns).toHaveLength(1)
  })
})

describe("user transcripts", () => {
  it("adds a completed user turn", () => {
    const state = fold(
      event({ type: "input-transcription-completed", itemId: "u1", transcript: "book a table" })
    )

    expect(state.turns).toEqual([{ id: "u1", role: "user", text: "book a table" }])
  })

  it("replaces rather than duplicates a re-sent item", () => {
    const state = fold(
      event({ type: "input-transcription-completed", itemId: "u1", transcript: "first" }),
      event({ type: "input-transcription-completed", itemId: "u1", transcript: "corrected" })
    )

    expect(state.turns).toEqual([{ id: "u1", role: "user", text: "corrected" }])
  })

  it("ignores an empty transcript", () => {
    const initial = createInitialLiveVoiceState()

    expect(
      reduceLiveVoiceServerEvent(
        initial,
        event({ type: "input-transcription-completed", itemId: "u1", transcript: "   " })
      )
    ).toBe(initial)
  })

  it("redacts PII before it can reach the UI", () => {
    const state = fold(
      event({
        type: "input-transcription-completed",
        itemId: "u1",
        transcript: "email me at alice@example.com",
      })
    )

    expect(state.turns[0].text).not.toContain("alice@example.com")
  })
})

describe("assistant transcripts", () => {
  it("accumulates deltas into the draft", () => {
    const state = fold(
      event({ type: "audio-transcript-delta", responseId: "r1", itemId: "a1", delta: "Sure" }),
      event({ type: "audio-transcript-delta", responseId: "r1", itemId: "a1", delta: ", done." })
    )

    expect(state.assistantDraft).toBe("Sure, done.")
    expect(state.phase).toBe("responding")
  })

  it("ignores an empty delta", () => {
    const started = fold(
      event({ type: "audio-transcript-delta", responseId: "r1", itemId: "a1", delta: "hi" })
    )

    expect(
      reduceLiveVoiceServerEvent(
        started,
        event({ type: "audio-transcript-delta", responseId: "r1", itemId: "a1", delta: "" })
      )
    ).toBe(started)
  })

  it("seals the turn using the authoritative transcript", () => {
    const state = fold(
      event({ type: "audio-transcript-delta", responseId: "r1", itemId: "a1", delta: "partial" }),
      event({
        type: "audio-transcript-done",
        responseId: "r1",
        itemId: "a1",
        transcript: "the full reply",
      })
    )

    expect(state.assistantDraft).toBe("")
    expect(state.turns).toEqual([{ id: "a1", role: "assistant", text: "the full reply" }])
  })

  it("falls back to the accumulated draft when done carries no transcript", () => {
    const state = fold(
      event({
        type: "audio-transcript-delta",
        responseId: "r1",
        itemId: "a1",
        delta: "from draft",
      }),
      event({ type: "audio-transcript-done", responseId: "r1", itemId: "a1" })
    )

    expect(state.turns).toEqual([{ id: "a1", role: "assistant", text: "from draft" }])
  })

  it("handles the text modality the same way", () => {
    const state = fold(
      event({ type: "text-delta", responseId: "r1", itemId: "a1", delta: "typed " }),
      event({ type: "text-done", responseId: "r1", itemId: "a1", text: "typed reply" })
    )

    expect(state.turns).toEqual([{ id: "a1", role: "assistant", text: "typed reply" }])
  })

  it("clears the draft but records nothing for an empty completion", () => {
    const state = fold(
      event({ type: "audio-transcript-delta", responseId: "r1", itemId: "a1", delta: "  " }),
      event({ type: "audio-transcript-done", responseId: "r1", itemId: "a1", transcript: "" })
    )

    expect(state.turns).toHaveLength(0)
    expect(state.assistantDraft).toBe("")
  })

  it("is a no-op when a done arrives with nothing buffered", () => {
    const listening = fold(event({ type: "session-created" }))

    expect(
      reduceLiveVoiceServerEvent(
        listening,
        event({ type: "audio-transcript-done", responseId: "r1", itemId: "a1" })
      )
    ).toBe(listening)
  })

  it("redacts PII in the assistant transcript too", () => {
    const state = fold(
      event({
        type: "audio-transcript-done",
        responseId: "r1",
        itemId: "a1",
        transcript: "I sent it to bob@example.com",
      })
    )

    expect(state.turns[0]?.text ?? "").not.toContain("bob@example.com")
  })
})

describe("errors", () => {
  it("records the provider message", () => {
    const state = fold(event({ type: "error", message: "rate limited", code: "429" }))

    expect(state).toMatchObject({ phase: "error", error: "rate limited" })
  })

  it("falls back to a generic message", () => {
    expect(fold(event({ type: "error", message: "" })).error).toBe("Realtime voice session failed")
  })
})

describe("referential stability", () => {
  // useSyncExternalStore re-renders on identity change, and audio-delta arrives
  // ~50 times a second. A fresh object per ignored event would spin the UI.
  const IGNORED: RealtimeServerEvent[] = [
    event({ type: "audio-delta", responseId: "r1", itemId: "a1", delta: "AAAA" }),
    event({ type: "audio-done", responseId: "r1", itemId: "a1" }),
    event({ type: "audio-committed", itemId: "u1" }),
    event({ type: "conversation-item-added", itemId: "u1", item: {} }),
    event({ type: "output-item-added", responseId: "r1", itemId: "a1" }),
    event({ type: "output-item-done", responseId: "r1", itemId: "a1" }),
    event({ type: "content-part-added", responseId: "r1", itemId: "a1" }),
    event({ type: "content-part-done", responseId: "r1", itemId: "a1" }),
    event({
      type: "function-call-arguments-delta",
      responseId: "r1",
      itemId: "a1",
      callId: "c1",
      delta: "{",
    }),
    event({
      type: "function-call-arguments-done",
      responseId: "r1",
      itemId: "a1",
      callId: "c1",
      name: "getWeather",
      arguments: "{}",
    }),
    event({ type: "custom", rawType: "vendor.thing" }),
  ]

  it.each(IGNORED.map((e) => [e.type, e] as const))(
    "returns the identical state object for %s",
    (_type, ignored) => {
      const state = fold(event({ type: "session-created" }))

      expect(reduceLiveVoiceServerEvent(state, ignored)).toBe(state)
    }
  )

  it("never mutates the state it was given", () => {
    const before = fold(event({ type: "session-created" }))
    const snapshot = JSON.stringify(before)

    reduceLiveVoiceServerEvent(
      before,
      event({ type: "input-transcription-completed", itemId: "u1", transcript: "hi" })
    )

    expect(JSON.stringify(before)).toBe(snapshot)
  })
})

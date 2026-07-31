/**
 * @jest-environment jsdom
 */

import type { UIMessage } from "ai"

interface SliceLike {
  status?: string
  steerQueue: Array<{ id: string; text: string; blocks?: unknown[] }>
  messages?: UIMessage[]
}

const state = {
  activeSessionId: null as string | null,
  status: "idle",
  sessions: {} as Record<string, SliceLike>,
  openSessionIds: [] as string[],
  clearSteerQueue: jest.fn((id: string) => {
    if (state.sessions[id]) state.sessions[id].steerQueue = []
  }),
  replaceSessionMessages: jest.fn((id: string, messages: UIMessage[]) => {
    if (state.sessions[id]) state.sessions[id].messages = messages
  }),
  updateSteerEntry: jest.fn((id: string, entryId: string, text: string) => {
    const entry = state.sessions[id]?.steerQueue.find((e) => e.id === entryId)
    if (entry) entry.text = text
  }),
  removeSteerEntry: jest.fn((id: string, entryId: string) => {
    const slice = state.sessions[id]
    if (slice) slice.steerQueue = slice.steerQueue.filter((e) => e.id !== entryId)
  }),
}

jest.mock("@/stores/chat", () => ({
  useChatStore: { getState: () => state },
}))

const mockPersistMessages = jest.fn(() => Promise.resolve())
jest.mock("@/lib/db/messages", () => ({
  persistMessages: (...args: unknown[]) => mockPersistMessages(...(args as [])),
}))

import {
  appendSteerMessage,
  discardPendingSteer,
  editPendingSteer,
  isSessionOpen,
  markPendingSteersFailed,
  maybeDrainSteer,
  promoteAcceptedSteers,
  sessionExternalLane,
  sessionStatusOf,
  setSessionExternalLane,
  setSteerMessageState,
  steerArmed,
} from "./steer-runtime"
import { steerMetaOf, type SteerState } from "@/lib/claude/steer"

/** A user message carrying steer metadata, as `send`'s optimistic append makes. */
function steerMessage(entryId: string, stateValue: SteerState, text = entryId): UIMessage {
  return {
    id: `m-${entryId}`,
    role: "user",
    parts: [{ type: "text", text }],
    metadata: { steer: { entryId, state: stateValue } },
  } as UIMessage
}

/** First text part of a message, or undefined when it has none. */
function textOf(message: UIMessage | undefined): string | undefined {
  return (message?.parts.find((p) => p.type === "text") as { text?: string } | undefined)?.text
}

/** Read back the rendered state of every steer message in a session. */
function statesOf(sessionId: string): Array<SteerState | null> {
  return (state.sessions[sessionId]?.messages ?? []).map(
    (m) => steerMetaOf(m.metadata)?.state ?? null
  )
}

beforeEach(() => {
  state.activeSessionId = null
  state.status = "idle"
  state.sessions = {}
  state.openSessionIds = []
  state.clearSteerQueue.mockClear()
  state.replaceSessionMessages.mockClear()
  state.updateSteerEntry.mockClear()
  state.removeSteerEntry.mockClear()
  mockPersistMessages.mockClear()
  steerArmed.clear()
  setSessionExternalLane("s1", null)
  setSessionExternalLane("s2", null)
})

describe("appendSteerMessage", () => {
  it("writes the optimistic bubble to Dexie, not just the store", async () => {
    // A steer that never leaves `queued` never reaches `patchSteerMessages`
    // either, so a store-only append meant a follow-up typed mid-turn and
    // killed by a restart vanished — the exact case the feature promises to
    // keep and mark "Not delivered".
    state.sessions["s1"] = { steerQueue: [], messages: [] }
    appendSteerMessage("s1", steerMessage("e1", "queued", "and add tests"))

    expect(statesOf("s1")).toEqual(["queued"])
    expect(mockPersistMessages).toHaveBeenCalledWith("s1", [
      expect.objectContaining({ id: "m-e1" }),
    ])
  })

  it("appends after the existing transcript rather than replacing it", () => {
    state.sessions["s1"] = {
      steerQueue: [],
      messages: [{ id: "m0", role: "user", parts: [{ type: "text", text: "first" }] } as UIMessage],
    }
    appendSteerMessage("s1", steerMessage("e1", "queued"))
    expect(state.sessions["s1"].messages?.map((m) => m.id)).toEqual(["m0", "m-e1"])
  })
})

describe("sessionExternalLane", () => {
  it("is per session, so a background pane does not read the focused pane's lane", () => {
    // `useAgentRuntimeStore` is one global "what my next turn will use"
    // selection; in split view that is whichever pane has focus, not the
    // session the follow-up was typed into.
    setSessionExternalLane("s1", "codex-1")
    expect(sessionExternalLane("s1")).toBe("codex-1")
    expect(sessionExternalLane("s2")).toBeNull()
  })

  it("clears when the turn settles, so the next turn is not steered as external", () => {
    state.sessions["s1"] = { steerQueue: [], messages: [] }
    setSessionExternalLane("s1", "codex-1")
    maybeDrainSteer("s1", jest.fn())
    expect(sessionExternalLane("s1")).toBeNull()
  })

  it("clears when the run fails, since the lane died with it", () => {
    state.sessions["s1"] = { steerQueue: [], messages: [] }
    setSessionExternalLane("s1", "codex-1")
    markPendingSteersFailed("s1", "boom")
    expect(sessionExternalLane("s1")).toBeNull()
  })
})

describe("sessionStatusOf", () => {
  it("prefers the session's own slice status", () => {
    state.sessions["s1"] = { status: "streaming", steerQueue: [] }
    expect(sessionStatusOf("s1")).toBe("streaming")
  })

  it("falls back to the active mirror for the focused session", () => {
    state.activeSessionId = "s1"
    state.status = "awaiting_approval"
    expect(sessionStatusOf("s1")).toBe("awaiting_approval")
  })

  it("reports idle for unknown background sessions", () => {
    expect(sessionStatusOf("ghost")).toBe("idle")
  })
})

describe("isSessionOpen", () => {
  it("is true only for sessions with a visible pane", () => {
    state.openSessionIds = ["s1"]
    expect(isSessionOpen("s1")).toBe(true)
    expect(isSessionOpen("s2")).toBe(false)
  })
})

describe("setSteerMessageState", () => {
  it("moves only the addressed entry and persists the change", () => {
    state.sessions["s1"] = {
      steerQueue: [],
      messages: [steerMessage("a", "queued"), steerMessage("b", "queued")],
    }
    setSteerMessageState("s1", "a", "accepted")
    expect(statesOf("s1")).toEqual(["accepted", "queued"])
    // The delivery state is the only record separating "the model saw this"
    // from "shown optimistically and never arrived", so it must reach disk.
    expect(mockPersistMessages).toHaveBeenCalledTimes(1)
  })

  it("records a reason when one is given", () => {
    state.sessions["s1"] = { steerQueue: [], messages: [steerMessage("a", "queued")] }
    setSteerMessageState("s1", "a", "failed", "stream closed")
    const meta = steerMetaOf(state.sessions["s1"].messages?.[0].metadata)
    expect(meta?.reason).toBe("stream closed")
  })

  it("does not rewrite or persist when the state already matches", () => {
    state.sessions["s1"] = { steerQueue: [], messages: [steerMessage("a", "accepted")] }
    setSteerMessageState("s1", "a", "accepted")
    expect(state.replaceSessionMessages).not.toHaveBeenCalled()
    expect(mockPersistMessages).not.toHaveBeenCalled()
  })

  it("leaves messages without steer metadata untouched", () => {
    const plain = { id: "p", role: "user", parts: [] } as unknown as UIMessage
    state.sessions["s1"] = { steerQueue: [], messages: [plain] }
    setSteerMessageState("s1", "a", "applied")
    expect(state.replaceSessionMessages).not.toHaveBeenCalled()
  })

  it("no-ops on a session with no messages", () => {
    setSteerMessageState("ghost", "a", "applied")
    expect(state.replaceSessionMessages).not.toHaveBeenCalled()
  })
})

describe("promoteAcceptedSteers", () => {
  it("promotes accepted to applied and leaves queued waiting", () => {
    state.sessions["s1"] = {
      steerQueue: [],
      messages: [steerMessage("a", "accepted"), steerMessage("b", "queued")],
    }
    promoteAcceptedSteers("s1")
    // `queued` was never handed to the sidecar, so the settled turn did not
    // carry it — it must keep waiting rather than claim delivery.
    expect(statesOf("s1")).toEqual(["applied", "queued"])
  })
})

describe("markPendingSteersFailed", () => {
  it("fails both queued and accepted, leaving terminal states alone", () => {
    state.sessions["s1"] = {
      steerQueue: [],
      messages: [
        steerMessage("a", "queued"),
        steerMessage("b", "accepted"),
        steerMessage("c", "applied"),
      ],
    }
    markPendingSteersFailed("s1", "boom")
    expect(statesOf("s1")).toEqual(["failed", "failed", "applied"])
  })
})

describe("editPendingSteer", () => {
  it("rewrites the queue entry and the bubble together", () => {
    state.sessions["s1"] = {
      steerQueue: [{ id: "a", text: "old" }],
      messages: [steerMessage("a", "queued", "old")],
    }
    editPendingSteer("s1", "a", "new")
    expect(state.updateSteerEntry).toHaveBeenCalledWith("s1", "a", "new")
    expect(textOf(state.sessions["s1"].messages?.[0])).toBe("new")
    expect(mockPersistMessages).toHaveBeenCalled()
  })

  it("adds a text part when the message carried only attachments", () => {
    const blocksOnly = {
      id: "m-a",
      role: "user",
      parts: [],
      metadata: { steer: { entryId: "a", state: "queued" } },
    } as unknown as UIMessage
    state.sessions["s1"] = { steerQueue: [{ id: "a", text: "" }], messages: [blocksOnly] }
    editPendingSteer("s1", "a", "describe it")
    expect(textOf(state.sessions["s1"].messages?.[0])).toBe("describe it")
  })

  it("still updates the queue when the session has no loaded messages", () => {
    state.sessions["s1"] = { steerQueue: [{ id: "a", text: "old" }] }
    editPendingSteer("s1", "a", "new")
    expect(state.updateSteerEntry).toHaveBeenCalledWith("s1", "a", "new")
    expect(state.replaceSessionMessages).not.toHaveBeenCalled()
  })
})

describe("discardPendingSteer", () => {
  it("drops the queue entry and its bubble", () => {
    state.sessions["s1"] = {
      steerQueue: [{ id: "a", text: "drop me" }],
      messages: [steerMessage("a", "queued"), steerMessage("b", "queued")],
    }
    discardPendingSteer("s1", "a")
    expect(state.removeSteerEntry).toHaveBeenCalledWith("s1", "a")
    expect(state.sessions["s1"].messages?.map((m) => m.id)).toEqual(["m-b"])
  })

  it("does not rewrite the transcript when no bubble matched", () => {
    state.sessions["s1"] = { steerQueue: [], messages: [steerMessage("b", "queued")] }
    discardPendingSteer("s1", "a")
    expect(state.replaceSessionMessages).not.toHaveBeenCalled()
  })
})

describe("maybeDrainSteer", () => {
  it("no-ops on an empty queue but always disarms", () => {
    steerArmed.add("s1")
    const replay = jest.fn()
    maybeDrainSteer("s1", replay)
    expect(replay).not.toHaveBeenCalled()
    expect(steerArmed.has("s1")).toBe(false)
    expect(state.clearSteerQueue).not.toHaveBeenCalled()
  })

  it("promotes accepted steers even when there is nothing queued to drain", () => {
    state.sessions["s1"] = { steerQueue: [], messages: [steerMessage("a", "accepted")] }
    maybeDrainSteer("s1", jest.fn())
    expect(statesOf("s1")).toEqual(["applied"])
  })

  it("clears the queue and replays one framed payload", () => {
    state.sessions["s1"] = {
      steerQueue: [
        { id: "a", text: "first" },
        { id: "b", text: "second" },
      ],
    }
    const replay = jest.fn()
    maybeDrainSteer("s1", replay)
    expect(state.clearSteerQueue).toHaveBeenCalledWith("s1")
    expect(replay).toHaveBeenCalledTimes(1)
    const payload = replay.mock.calls[0][0]
    const text = typeof payload === "string" ? payload : JSON.stringify(payload)
    expect(text).toContain("first")
    expect(text).toContain("second")
  })

  it("marks the drained entries applied before dispatching the replay", () => {
    const seenAtReplay: Array<SteerState | null> = []
    state.sessions["s1"] = {
      steerQueue: [{ id: "a", text: "first" }],
      messages: [steerMessage("a", "queued", "first")],
    }
    maybeDrainSteer("s1", () => {
      // `replay` runs synchronously into `send`, which persists the transcript;
      // flipping after would race that write.
      seenAtReplay.push(...statesOf("s1"))
    })
    expect(seenAtReplay).toEqual(["applied"])
  })
})

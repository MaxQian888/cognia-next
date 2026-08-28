/** @jest-environment jsdom */
import { act, renderHook } from "@testing-library/react"

import type { AcpElicitationRequest } from "@/types/agent/external-agent"

import {
  useExternalElicitationStore,
  useSessionPendingElicitation,
} from "./external-elicitation-store"

function request(
  id: string,
  overrides: Partial<AcpElicitationRequest> = {}
): AcpElicitationRequest {
  return {
    id,
    mode: "form",
    message: `question ${id}`,
    raw: {},
    ...overrides,
  }
}

const entry = (chatSessionId: string, id: string, agentId = "agent-a") => ({
  chatSessionId,
  agentId,
  request: request(id),
})

beforeEach(() => useExternalElicitationStore.setState({ bySession: {} }))

describe("push", () => {
  it("keeps questions per chat session, oldest first", () => {
    const store = useExternalElicitationStore.getState()
    store.push(entry("chat-1", "q1"))
    store.push(entry("chat-1", "q2"))
    store.push(entry("chat-2", "q3"))

    const { bySession } = useExternalElicitationStore.getState()
    expect(bySession["chat-1"].map((e) => e.request.id)).toEqual(["q1", "q2"])
    expect(bySession["chat-2"].map((e) => e.request.id)).toEqual(["q3"])
  })

  // An adapter that reconnects re-emits its outstanding request. Stacking a
  // duplicate would put a second identical dialog behind the first, and the
  // user would answer the one they did not read.
  it("ignores a re-emitted question", () => {
    const store = useExternalElicitationStore.getState()
    store.push(entry("chat-1", "q1"))
    store.push(entry("chat-1", "q1"))
    expect(useExternalElicitationStore.getState().bySession["chat-1"]).toHaveLength(1)
  })

  it("carries the agent id the response has to be addressed to", () => {
    useExternalElicitationStore.getState().push(entry("chat-1", "q1", "agent-z"))
    expect(useExternalElicitationStore.getState().bySession["chat-1"][0].agentId).toBe("agent-z")
  })
})

describe("remove", () => {
  it("drops the named question and promotes the next", () => {
    const store = useExternalElicitationStore.getState()
    store.push(entry("chat-1", "q1"))
    store.push(entry("chat-1", "q2"))
    store.remove("chat-1", "q1")
    expect(
      useExternalElicitationStore.getState().bySession["chat-1"].map((e) => e.request.id)
    ).toEqual(["q2"])
  })

  // The dialog answers by `request.id`, but an agent withdrawing a question
  // emits `elicitation_complete` carrying `elicitationId` — a different field.
  // Matching only one leaves a dead dialog on screen.
  it("matches elicitationId as well as the local id", () => {
    useExternalElicitationStore.getState().push({
      chatSessionId: "chat-1",
      agentId: "a",
      request: request("local-1", { elicitationId: "wire-9" }),
    })
    useExternalElicitationStore.getState().remove("chat-1", "wire-9")
    expect(useExternalElicitationStore.getState().bySession["chat-1"]).toBeUndefined()
  })

  it("drops the session key once nothing is left", () => {
    useExternalElicitationStore.getState().push(entry("chat-1", "q1"))
    useExternalElicitationStore.getState().remove("chat-1", "q1")
    expect(useExternalElicitationStore.getState().bySession).toEqual({})
  })

  it("is a no-op for an unknown session or id", () => {
    const store = useExternalElicitationStore.getState()
    store.push(entry("chat-1", "q1"))
    const before = useExternalElicitationStore.getState().bySession
    store.remove("chat-2", "q1")
    store.remove("chat-1", "nope")
    expect(useExternalElicitationStore.getState().bySession).toBe(before)
  })
})

describe("clearSession", () => {
  it("returns what it dropped so the caller can cancel each one", () => {
    const store = useExternalElicitationStore.getState()
    store.push(entry("chat-1", "q1"))
    store.push(entry("chat-1", "q2"))
    store.push(entry("chat-2", "q3"))

    const dropped = useExternalElicitationStore.getState().clearSession("chat-1")
    expect(dropped.map((e) => e.request.id)).toEqual(["q1", "q2"])
    expect(useExternalElicitationStore.getState().bySession["chat-1"]).toBeUndefined()
    // Another pane's question is untouched — a turn ending in one pane must not
    // cancel a question the user is answering in the other.
    expect(useExternalElicitationStore.getState().bySession["chat-2"]).toHaveLength(1)
  })

  it("returns an empty list for a session with nothing pending", () => {
    expect(useExternalElicitationStore.getState().clearSession("chat-none")).toEqual([])
  })
})

describe("useSessionPendingElicitation", () => {
  it("returns the head of the queue and re-renders as it changes", () => {
    const { result } = renderHook(() => useSessionPendingElicitation("chat-1"))
    expect(result.current).toBeNull()

    act(() => {
      useExternalElicitationStore.getState().push(entry("chat-1", "q1"))
      useExternalElicitationStore.getState().push(entry("chat-1", "q2"))
    })
    expect(result.current?.request.id).toBe("q1")

    // Answering the head promotes the next question rather than closing the
    // dialog outright.
    act(() => useExternalElicitationStore.getState().remove("chat-1", "q1"))
    expect(result.current?.request.id).toBe("q2")

    act(() => {
      useExternalElicitationStore.getState().clearSession("chat-1")
    })
    expect(result.current).toBeNull()
  })

  it("ignores another pane's questions", () => {
    const { result } = renderHook(() => useSessionPendingElicitation("chat-1"))
    act(() => useExternalElicitationStore.getState().push(entry("chat-2", "q1")))
    expect(result.current).toBeNull()
  })

  it("returns null without a session", () => {
    const { result } = renderHook(() => useSessionPendingElicitation(null))
    expect(result.current).toBeNull()
  })
})

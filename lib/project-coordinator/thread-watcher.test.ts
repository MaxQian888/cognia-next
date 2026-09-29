import type { ChatSession } from "@cognia/agent-config-types"
import type { UIMessage } from "ai"
import { useChatStore } from "@/stores/chat"
import { settledThreadTurns, toThreadReport, watchProjectThreadTurns } from "./thread-watcher"

const thread = {
  id: "t1",
  title: "Fix login",
  createdAt: 1,
  updatedAt: 1,
  projectRole: "thread",
  projectThread: {
    coordinatorSessionId: "coord",
    brief: "b",
    proposedBy: "coordinator",
    declaredState: "ready-for-review",
  },
} as ChatSession

const assistant = (text: string): UIMessage => ({
  id: "a",
  role: "assistant",
  parts: [{ type: "text", text }],
})

const slice = (status: "idle" | "streaming" | "error" | "awaiting_approval", extra = {}) => ({
  status,
  messages: [] as UIMessage[],
  errorMessage: null as string | null,
  ...extra,
})

describe("settledThreadTurns", () => {
  const threadOf = (id: string) => (id === "t1" ? thread : undefined)

  it("reports a finished turn with its final assistant text", () => {
    expect(
      settledThreadTurns(
        { t1: slice("streaming") },
        { t1: slice("idle", { messages: [assistant("All green")] }) },
        threadOf
      )
    ).toEqual([{ thread, outcome: "completed", summary: "All green" }])
  })

  it("reports an error turn, and ignores non-threads and non-transitions", () => {
    expect(
      settledThreadTurns(
        { t1: slice("awaiting_approval"), other: slice("streaming") },
        { t1: slice("error", { errorMessage: "boom" }), other: slice("idle") },
        threadOf
      )
    ).toEqual([{ thread, outcome: "error", summary: "boom" }])
    expect(settledThreadTurns({ t1: slice("idle") }, { t1: slice("idle") }, threadOf)).toEqual([])
    expect(
      settledThreadTurns({ t1: slice("streaming") }, { t1: slice("awaiting_approval") }, threadOf)
    ).toEqual([])
  })
})

describe("toThreadReport", () => {
  it("carries the declared state and needs a coordinator", () => {
    expect(toThreadReport({ thread, outcome: "completed", summary: "s" })).toEqual({
      threadId: "t1",
      coordinatorSessionId: "coord",
      title: "Fix login",
      outcome: "completed",
      summary: "s",
      declaredState: "ready-for-review",
    })
    expect(
      toThreadReport({
        thread: { ...thread, projectThread: undefined },
        outcome: "completed",
        summary: "s",
      })
    ).toBeUndefined()
  })
})

describe("watchProjectThreadTurns", () => {
  beforeEach(() => useChatStore.getState().clear())

  it("reports and releases on settle, but not for a thread being stopped", () => {
    const report = jest.fn()
    const release = jest.fn()
    let stopping = false
    const stop = watchProjectThreadTurns((id) => (id === "t1" ? thread : undefined), {
      report,
      release,
      isStopping: () => stopping,
    })
    const store = useChatStore.getState()
    store.holdInBackground("t1", "project-thread")
    store.setSessionStatus("t1", "streaming")
    store.setSessionMessages("t1", [assistant("Done")])
    store.setSessionStatus("t1", "idle")
    expect(report).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: "t1", summary: "Done" })
    )
    expect(release).toHaveBeenCalledWith("t1")

    stopping = true
    store.setSessionStatus("t1", "streaming")
    store.setSessionStatus("t1", "idle")
    expect(report).toHaveBeenCalledTimes(1)
    stop()
  })
})

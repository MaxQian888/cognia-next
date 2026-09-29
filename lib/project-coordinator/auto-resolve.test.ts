import type { ChatSession } from "@cognia/agent-config-types"
import { coordinatorNeedsHold, sweepIdleThreads } from "./auto-resolve"
import { THREAD_AUTO_RESOLVE_MS } from "./thread-state"

const NOW = 100 * THREAD_AUTO_RESOLVE_MS
const thread = (id: string, extra: Partial<ChatSession> = {}): ChatSession =>
  ({
    id,
    title: id,
    createdAt: 1,
    updatedAt: NOW - THREAD_AUTO_RESOLVE_MS,
    projectRole: "thread",
    projectThread: { coordinatorSessionId: "c", brief: "b", proposedBy: "coordinator" },
    attachedChild: {
      parentSessionId: "c",
      lifecycleOwnerSessionId: "c",
      context: { mode: "none" },
      workspace: "independent",
      status: "completed",
      createdAt: 1,
    },
    ...extra,
  }) as ChatSession

describe("sweepIdleThreads", () => {
  it("resolves only quiet threads older than a week", async () => {
    const resolve = jest.fn(async () => undefined)
    const count = await sweepIdleThreads(
      [thread("old"), thread("fresh", { updatedAt: NOW }), thread("busy"), thread("asking")],
      {
        statusOf: (id) => (id === "busy" ? "streaming" : "idle"),
        pendingApprovals: (id) => (id === "asking" ? 1 : 0),
        resolve,
        now: () => NOW,
      }
    )
    expect(count).toBe(1)
    expect(resolve).toHaveBeenCalledWith("old")
  })
})

describe("coordinatorNeedsHold", () => {
  it("holds while a thread works or is started, not for quiet or resolved ones", () => {
    const running = { ...thread("x").attachedChild!, status: "running" as const }
    expect(coordinatorNeedsHold([thread("a")], () => "idle")).toBe(false)
    expect(coordinatorNeedsHold([thread("a")], () => "streaming")).toBe(true)
    expect(coordinatorNeedsHold([thread("a", { attachedChild: running })], () => "idle")).toBe(true)
    expect(
      coordinatorNeedsHold(
        [
          thread("a", {
            attachedChild: running,
            projectThread: { ...thread("a").projectThread!, resolvedAt: 1 },
          }),
        ],
        () => "idle"
      )
    ).toBe(false)
  })
})

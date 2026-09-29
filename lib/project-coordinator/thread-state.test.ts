import type { ChatSession } from "@cognia/agent-config-types"
import {
  THREAD_AUTO_RESOLVE_MS,
  THREAD_BOARD_ORDER,
  deriveThreadState,
  shouldAutoResolve,
  type ThreadStateInput,
} from "./thread-state"

const NOW = 10 * THREAD_AUTO_RESOLVE_MS

function input(
  thread: Partial<ChatSession> = {},
  extra: Partial<Omit<ThreadStateInput, "thread">> = {}
): ThreadStateInput {
  return {
    thread: {
      id: "t",
      title: "t",
      createdAt: NOW,
      updatedAt: NOW,
      projectRole: "thread",
      projectThread: { coordinatorSessionId: "c", brief: "b", proposedBy: "coordinator" },
      attachedChild: {
        parentSessionId: "c",
        lifecycleOwnerSessionId: "c",
        context: { mode: "none" },
        workspace: "independent",
        status: "completed",
        createdAt: NOW,
      },
      ...thread,
    } as ChatSession,
    status: "idle",
    pendingApprovals: 0,
    now: NOW,
    ...extra,
  }
}

const child = (status: "staged" | "running" | "interrupted") => ({
  ...input().thread.attachedChild!,
  status,
})

describe("deriveThreadState", () => {
  it("puts what needs the user first", () => {
    expect(deriveThreadState(input({}, { status: "awaiting_approval" }))).toBe("waiting")
    expect(deriveThreadState(input({}, { pendingApprovals: 1 }))).toBe("waiting")
    expect(deriveThreadState(input({}, { status: "error" }))).toBe("waiting")
    expect(deriveThreadState(input({ attachedChild: child("interrupted") }))).toBe("waiting")
    expect(
      deriveThreadState(
        input({ projectThread: { ...input().thread.projectThread!, declaredState: "blocked" } })
      )
    ).toBe("waiting")
  })

  it("tracks the run lifecycle", () => {
    expect(deriveThreadState(input({}, { status: "streaming" }))).toBe("working")
    expect(deriveThreadState(input({ attachedChild: child("staged") }))).toBe("staged")
    expect(
      deriveThreadState(
        input({
          attachedChild: child("running"),
          spawnedTask: { mode: "aside", pendingPrompt: "x" },
        })
      )
    ).toBe("working")
    expect(deriveThreadState(input())).toBe("idle")
  })

  it("lets an observed pull request beat a declared state", () => {
    const declaredLanding = input({
      projectThread: { ...input().thread.projectThread!, declaredState: "landing" },
    })
    expect(deriveThreadState(declaredLanding)).toBe("landing")
    expect(deriveThreadState({ ...declaredLanding, pr: "ci_failed" })).toBe("ready-for-review")
    expect(deriveThreadState(input({}, { pr: "mergeable" }))).toBe("landing")
    expect(deriveThreadState(input({}, { pr: "merged" }))).toBe("idle")
    expect(
      deriveThreadState(
        input({
          projectThread: { ...input().thread.projectThread!, declaredState: "ready-for-review" },
        })
      )
    ).toBe("ready-for-review")
  })

  it("resolved wins over everything", () => {
    expect(
      deriveThreadState(
        input(
          { projectThread: { ...input().thread.projectThread!, resolvedAt: 1 } },
          { status: "streaming" }
        )
      )
    ).toBe("resolved")
  })

  it("orders every state on the board", () => {
    expect(new Set(THREAD_BOARD_ORDER).size).toBe(7)
  })
})

describe("shouldAutoResolve", () => {
  const stale = { updatedAt: NOW - THREAD_AUTO_RESOLVE_MS }
  it("resolves a quiet thread after a week", () => {
    expect(shouldAutoResolve(input(stale))).toBe(true)
    expect(shouldAutoResolve(input({ updatedAt: NOW - THREAD_AUTO_RESOLVE_MS + 1 }))).toBe(false)
  })
  it("never resolves work in flight, a pending ask, or an already-resolved thread", () => {
    expect(shouldAutoResolve(input(stale, { status: "streaming" }))).toBe(false)
    expect(shouldAutoResolve(input(stale, { pendingApprovals: 1 }))).toBe(false)
    expect(
      shouldAutoResolve(
        input({ ...stale, projectThread: { ...input().thread.projectThread!, resolvedAt: 1 } })
      )
    ).toBe(false)
  })
})

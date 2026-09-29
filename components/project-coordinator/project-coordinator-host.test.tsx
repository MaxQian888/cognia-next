/**
 * @jest-environment jsdom
 */
import { act, render } from "@testing-library/react"
import type { ChatSession } from "@cognia/agent-config-types"
import type { Project } from "@/types"

let threads: Array<[string, ChatSession[]]> = []
jest.mock("@/hooks/data", () => ({ useClientLiveQuery: () => threads }))
jest.mock("@/lib/project-coordinator/thread-runtime", () => ({
  listProjectThreads: jest.fn(),
  resolveThread: jest.fn(async () => true),
  resumeProjectThreads: jest.fn(async () => undefined),
}))
jest.mock("@/lib/project-coordinator/thread-watcher", () => ({
  watchProjectThreadTurns: jest.fn(() => jest.fn()),
}))

import { useChatStore } from "@/stores/chat"
import { useProjectStore } from "@/stores/project/project-store"
import { resolveThread, resumeProjectThreads } from "@/lib/project-coordinator/thread-runtime"
import { watchProjectThreadTurns } from "@/lib/project-coordinator/thread-watcher"
import { THREAD_AUTO_RESOLVE_MS } from "@/lib/project-coordinator/thread-state"
import {
  AUTO_RESOLVE_INTERVAL_MS,
  COORDINATOR_HOLDER_ID,
  ProjectCoordinatorHost,
} from "./project-coordinator-host"

const thread = (id: string, extra: Partial<ChatSession> = {}): ChatSession =>
  ({
    id,
    title: id,
    createdAt: 1,
    updatedAt: 1,
    projectRole: "thread",
    projectThread: { coordinatorSessionId: "coord", brief: "b", proposedBy: "coordinator" },
    attachedChild: {
      parentSessionId: "coord",
      lifecycleOwnerSessionId: "coord",
      context: { mode: "none" },
      workspace: "independent",
      status: "completed",
      createdAt: 1,
    },
    ...extra,
  }) as ChatSession

beforeEach(() => {
  jest.clearAllMocks()
  useChatStore.getState().clear()
  useProjectStore.setState({
    projects: [
      { id: "p1", coordinator: { enabled: true, sessionId: "coord" } } as Project,
      { id: "p2", coordinator: { enabled: false, sessionId: "off" } } as Project,
    ],
  })
})

describe("ProjectCoordinatorHost", () => {
  it("installs the watcher once and reconciles each enabled coordinator", () => {
    threads = [["coord", [thread("t1")]]]
    const { rerender } = render(<ProjectCoordinatorHost />)
    rerender(<ProjectCoordinatorHost />)
    expect(watchProjectThreadTurns).toHaveBeenCalledTimes(1)
    expect(resumeProjectThreads).toHaveBeenCalledTimes(1)
    expect(resumeProjectThreads).toHaveBeenCalledWith("coord")
    const threadOf = (watchProjectThreadTurns as jest.Mock).mock.calls[0][0]
    expect(threadOf("t1")?.id).toBe("t1")
    expect(threadOf("nope")).toBeUndefined()
  })

  it("holds the coordinator while a thread is started, releases when quiet", () => {
    const running = { ...thread("x").attachedChild!, status: "running" as const }
    threads = [["coord", [thread("t1", { attachedChild: running })]]]
    const { rerender } = render(<ProjectCoordinatorHost />)
    expect(useChatStore.getState().backgroundHolds.coord).toEqual([COORDINATOR_HOLDER_ID])
    threads = [["coord", [thread("t1")]]]
    rerender(<ProjectCoordinatorHost />)
    expect(useChatStore.getState().backgroundHolds.coord).toBeUndefined()
  })

  it("sweeps quiet threads on a timer", async () => {
    jest.useFakeTimers()
    try {
      jest.setSystemTime(10 * THREAD_AUTO_RESOLVE_MS)
      threads = [["coord", [thread("old")]]]
      render(<ProjectCoordinatorHost />)
      await act(async () => {
        jest.advanceTimersByTime(AUTO_RESOLVE_INTERVAL_MS)
      })
      expect(resolveThread).toHaveBeenCalledWith("old", "auto")
    } finally {
      jest.useRealTimers()
    }
  })
})

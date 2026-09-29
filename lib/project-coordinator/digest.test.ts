import type { ChatSession } from "@cognia/agent-config-types"
import { DIGEST_MAX_THREADS, buildCoordinatorContextSection } from "./digest"

const thread = (id: string, extra: Partial<ChatSession> = {}): ChatSession =>
  ({
    id,
    title: `Task ${id}`,
    createdAt: 1,
    updatedAt: Number(id.replace(/\D/g, "")) || 1,
    projectRole: "thread",
    projectThread: { coordinatorSessionId: "c", brief: "b", proposedBy: "coordinator" },
    attachedChild: {
      parentSessionId: "c",
      lifecycleOwnerSessionId: "c",
      context: { mode: "none" },
      workspace: "independent",
      status: "completed",
      createdAt: 1,
      result: { summary: `Result   of\n${id}`, completedAt: 2 },
    },
    ...extra,
  }) as ChatSession

describe("buildCoordinatorContextSection", () => {
  it("lists preferences and the recent unresolved threads with their state", () => {
    const section = buildCoordinatorContextSection(
      {
        coordinator: {
          enabled: true,
          preferences: { proposeBeforeStart: true, maxConcurrentThreads: 2 },
        },
      },
      [
        {
          thread: thread("t2", {
            executionContext: { branch: "thread/x" } as ChatSession["executionContext"],
          }),
          status: "streaming",
          pendingApprovals: 0,
        },
        {
          thread: thread("t1", {
            projectThread: {
              coordinatorSessionId: "c",
              brief: "b",
              proposedBy: "user",
              resolvedAt: 1,
            },
          }),
          status: "idle",
          pendingApprovals: 0,
        },
      ],
      100
    )
    expect(section).toContain("## Project status")
    expect(section).toContain("Propose before starting: yes")
    expect(section).toContain("Max concurrent threads: 2")
    expect(section).toContain("Threads (working: 1, resolved: 1):")
    expect(section).toContain("- Task t2 (t2) — working · branch thread/x")
    expect(section).toContain("last result: Result of t2")
    expect(section).not.toContain("Task t1 (t1)")
  })

  it("caps the listed threads and says when there are none", () => {
    const many = Array.from({ length: DIGEST_MAX_THREADS + 5 }, (_, i) => ({
      thread: thread(`t${i + 1}`),
      status: "idle" as const,
      pendingApprovals: 0,
    }))
    const section = buildCoordinatorContextSection({ coordinator: { enabled: true } }, many, 100)
    expect(section.match(/^- Task /gm)).toHaveLength(DIGEST_MAX_THREADS)
    expect(section).toContain(`Task t${DIGEST_MAX_THREADS + 5} `)
    expect(buildCoordinatorContextSection({ coordinator: { enabled: true } }, [], 1)).toContain(
      "Threads: none yet."
    )
  })
})

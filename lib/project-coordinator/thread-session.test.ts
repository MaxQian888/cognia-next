import type { ChatSession } from "@cognia/agent-config-types"
import type { Project } from "@/types"
import type { AttachedSessionDeps } from "@/lib/chat/attached-session"
import type { SpawnedTaskBrief } from "@/lib/tasks/spawn-task-core"
import {
  ThreadCreationError,
  createThreadSession,
  threadWorktreeName,
  type ThreadSessionDeps,
} from "./thread-session"

const brief: SpawnedTaskBrief = {
  title: "Fix flaky login test",
  tldr: "The login test times out on CI.",
  situation: "It waits on a real network call.",
  codeLocations: ["tests/login.test.ts:12"],
  solution: "Stub the call.",
  caveats: [],
  mode: "aside",
}

function setup(project: Partial<Project> = {}, coordinator: Partial<ChatSession> = {}) {
  const rows = new Map<string, ChatSession>([
    [
      "coord",
      {
        id: "coord",
        projectId: "p1",
        projectRole: "coordinator",
        title: "Coordinator",
        createdAt: 1,
        updatedAt: 1,
        ...coordinator,
      } as ChatSession,
    ],
  ])
  const updates: Array<{ id: string; patch: Partial<ChatSession> }> = []
  const attached: AttachedSessionDeps = {
    getSession: async (id) => rows.get(id),
    listChildren: async () => [],
    createChild: async () => {
      throw new Error("thread-session must override createChild")
    },
    listMessages: async () => [],
    updateSession: async (id, patch) => {
      updates.push({ id, patch })
      const row = rows.get(id)
      if (row) rows.set(id, { ...row, ...patch })
    },
    deleteChild: jest.fn(async () => undefined),
    gateInheritedContent: () => true,
    now: () => 50,
  }
  const startNewSession = jest.fn(
    async (input: Parameters<ThreadSessionDeps["startNewSession"]>[0]) => {
      const session = {
        id: "thread-1",
        projectId: input.projectId,
        title: input.title ?? "",
        workingDir: "/wt",
        executionContext: {
          location: input.executionLocation ?? "local",
          projectId: "p1",
          projectRoot: "/repo",
          taskWorkspace: { taskId: "t", workspaceKey: "k" },
        },
        createdAt: 50,
        updatedAt: 50,
      } as ChatSession
      rows.set(session.id, session)
      return session
    }
  )
  const deps: ThreadSessionDeps = {
    getProject: (id) =>
      id === "p1"
        ? ({
            id: "p1",
            roots: [
              { id: "main", path: "/repo", isPrimary: true },
              { id: "docs", path: "/docs", isPrimary: false },
            ],
            coordinator: { enabled: true },
            ...project,
          } as Project)
        : undefined,
    attached,
    startNewSession,
    isGitRepo: jest.fn(async () => true),
    gateBrief: jest.fn(() => true),
    now: () => 1_700_000_000_000,
  }
  return { deps, rows, updates, startNewSession }
}

describe("threadWorktreeName", () => {
  it("slugs the title and appends a short unique suffix", () => {
    expect(threadWorktreeName("Fix: Flaky LOGIN test!", "abc123xyz")).toBe(
      "thread/fix-flaky-login-test-123xyz"
    )
    expect(threadWorktreeName("修复", "zz")).toBe("thread/task-zz")
  })
})

describe("createThreadSession", () => {
  it("creates a visible, staged thread in its own worktree without touching workspace defaults", async () => {
    const { deps, rows, startNewSession } = setup()
    const thread = await createThreadSession(
      { projectId: "p1", coordinatorSessionId: "coord", brief, proposedBy: "coordinator" },
      deps
    )
    expect(startNewSession).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "p1",
        title: brief.title,
        activate: false,
        rememberChoice: false,
        executionLocation: "managedWorktree",
        executionBase: { kind: "localHead" },
        worktreeName: expect.stringMatching(/^thread\/fix-flaky-login-test-/),
        rootId: "main",
      })
    )
    const row = rows.get(thread.id)!
    expect(row.kind).toBeUndefined()
    expect(row.visibility).toBeUndefined()
    expect(row).toMatchObject({
      parentSessionId: "coord",
      projectRole: "thread",
      titleAuto: false,
      workingDir: "/wt",
      attachedChild: {
        status: "staged",
        workspace: "independent",
        lifecycleOwnerSessionId: "coord",
      },
      projectThread: { coordinatorSessionId: "coord", proposedBy: "coordinator" },
    })
    expect(row.spawnedTask?.pendingPrompt).toContain("# Fix flaky login test")
    expect(row.executionContext?.location).toBe("managedWorktree")
  })

  it("targets a named root and applies the thread model choice", async () => {
    const { deps, rows, startNewSession } = setup({
      coordinator: {
        enabled: true,
        threadExecution: "local",
        model: { threads: { modelId: "claude-haiku-4-5-20251001", effort: "medium" } },
      },
    })
    const thread = await createThreadSession(
      { projectId: "p1", coordinatorSessionId: "coord", brief, rootId: "docs", proposedBy: "user" },
      deps
    )
    expect(startNewSession).toHaveBeenCalledWith(
      expect.objectContaining({
        executionLocation: "local",
        rootId: "docs",
        model: "claude-haiku-4-5-20251001",
      })
    )
    expect(startNewSession.mock.calls[0][0]).not.toHaveProperty("worktreeName")
    expect(rows.get(thread.id)).toMatchObject({
      effort: "medium",
      projectThread: { rootId: "docs", proposedBy: "user" },
    })
  })

  it("refuses a brief the PII gate blocks, before creating anything", async () => {
    const { deps, startNewSession } = setup()
    ;(deps.gateBrief as jest.Mock).mockReturnValue(false)
    await expect(
      createThreadSession(
        { projectId: "p1", coordinatorSessionId: "coord", brief, proposedBy: "coordinator" },
        deps
      )
    ).rejects.toMatchObject({ reason: "pii" })
    expect(startNewSession).not.toHaveBeenCalled()
  })

  it("refuses when the parent is not this workspace's coordinator", async () => {
    const { deps } = setup({}, { projectRole: undefined })
    await expect(
      createThreadSession(
        { projectId: "p1", coordinatorSessionId: "coord", brief, proposedBy: "coordinator" },
        deps
      )
    ).rejects.toBeInstanceOf(ThreadCreationError)
    await expect(
      createThreadSession(
        { projectId: "nope", coordinatorSessionId: "coord", brief, proposedBy: "coordinator" },
        deps
      )
    ).rejects.toMatchObject({ reason: "workspace-missing" })
  })
})

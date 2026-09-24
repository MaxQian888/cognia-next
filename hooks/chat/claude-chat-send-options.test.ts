import { buildSendOptions, buildWorkingSetPostCompaction } from "./claude-chat-send-options"
import { resolveSendOptions } from "@/lib/claude/build-options"
import { useProjectStore } from "@/stores/project/project-store"
import { useGitStore } from "@/stores/git/git-store"
import { createOnboardingRequest } from "@/lib/onboarding/request"

jest.mock("@/lib/claude/build-options", () => ({
  resolveSendOptions: jest.fn(async () => ({})),
}))
jest.mock("@/stores/project/project-store", () => ({
  useProjectStore: { getState: jest.fn() },
}))
jest.mock("@/stores/settings", () => ({
  useSettingsStore: { getState: () => ({ settings: {} }) },
}))
jest.mock("@/stores/chat", () => ({
  useChatStore: {
    getState: () => ({
      referencedPaths: [],
      ephemeralSkillIds: [],
      activeSessionId: null,
      messages: [],
      sessions: {},
    }),
  },
  // The send path resolves ad-hoc skills against THIS session's slice now, so
  // the seam has to expose the selector the same way the real store does.
  selectComposerEphemeralSkillIds: (
    state: {
      sessions?: Record<string, { ephemeralSkillIds?: string[] }>
      ephemeralSkillIds?: string[]
    },
    sessionId?: string | null
  ) =>
    (sessionId ? state.sessions?.[sessionId]?.ephemeralSkillIds : undefined) ??
    state.ephemeralSkillIds ??
    [],
}))
jest.mock("@/stores/git/git-store", () => ({
  useGitStore: { getState: jest.fn(() => ({ status: null, rootDir: undefined })) },
}))
const mockGitStatus = jest.fn()
jest.mock("@/lib/git/commands", () => ({
  gitStatus: (...args: unknown[]) => mockGitStatus(...args),
}))
jest.mock("@/lib/workspace/trust-gate", () => ({
  resolveWorkspaceTrustForSend: jest.fn(async () => ({ restricted: false, trustedRoots: [] })),
}))
jest.mock("@/lib/usage/compaction-metrics", () => ({ pendingRecoveryPhase: () => null }))
jest.mock("@/lib/goal/runtime", () => ({
  getGoalRuntime: () => ({ getActiveGoalForSession: async () => null }),
}))
jest.mock("@/lib/loop/runtime", () => ({
  getLoopRuntime: () => ({ getActiveLoopForSession: async () => null }),
}))
// Read through a global: modules call `isTauri()` while this file is still importing.
jest.mock("@/lib/tauri", () => ({
  isTauri: () => (globalThis as { __mockIsTauri?: boolean }).__mockIsTauri === true,
}))

const PROJECT_A = {
  id: "proj-a",
  name: "A",
  roots: [{ id: "ra", path: "/repos/a", isPrimary: true }],
}
const PROJECT_B = {
  id: "proj-b",
  name: "B",
  roots: [{ id: "rb", path: "/repos/b", isPrimary: true }],
}

describe("Claude chat send-option seam", () => {
  beforeEach(() => {
    localStorage.clear()
    jest.mocked(resolveSendOptions).mockClear()
    jest.mocked(useProjectStore.getState).mockReturnValue({
      projects: [PROJECT_A, PROJECT_B],
      activeProjectId: "proj-a",
    } as never)
  })

  it("exports the send-option resolver", () => {
    expect(typeof buildSendOptions).toBe("function")
  })

  it("restores active working-set entries only for the pending compaction phase", () => {
    const workingSet = {
      contractVersion: 1 as const,
      revision: 2,
      updatedAt: 20,
      entries: [
        {
          id: "active",
          kind: "decision" as const,
          summary: "Reuse the execution journal",
          status: "active" as const,
          origin: "agent" as const,
          refs: [],
          createdAt: 10,
          updatedAt: 20,
        },
        {
          id: "resolved",
          kind: "fact" as const,
          summary: "Do not restore this",
          status: "resolved" as const,
          origin: "agent" as const,
          refs: [],
          createdAt: 10,
          updatedAt: 20,
        },
      ],
    }

    expect(buildWorkingSetPostCompaction(null, workingSet)).toBeUndefined()
    const recovery = buildWorkingSetPostCompaction(3, workingSet)
    expect(recovery).toMatchObject({ phaseNumber: 3 })
    expect(recovery?.durableInstructions).toContain("Reuse the execution journal")
    expect(recovery?.durableInstructions).not.toContain("Do not restore this")
  })

  it("blocks an unsafe persisted resource reference at the outbound boundary", () => {
    expect(() =>
      buildWorkingSetPostCompaction(2, {
        contractVersion: 1,
        revision: 1,
        updatedAt: 20,
        entries: [
          {
            id: "unsafe",
            kind: "resource",
            summary: "Inspect the resource",
            status: "active",
            origin: "agent",
            refs: [{ namespace: "cognia", type: "file", id: "jane@example.com" }],
            createdAt: 10,
            updatedAt: 20,
          },
        ],
      })
    ).toThrow("PII gate")
  })

  it("places the encrypted checkpoint before the current working set", () => {
    const recovery = buildWorkingSetPostCompaction(
      2,
      {
        contractVersion: 1,
        revision: 1,
        updatedAt: 20,
        entries: [
          {
            id: "active",
            kind: "fact",
            summary: "Current state",
            status: "active",
            origin: "agent",
            refs: [],
            createdAt: 10,
            updatedAt: 20,
          },
        ],
      },
      "Compaction checkpoint compact-1"
    )
    expect(recovery?.durableInstructions?.indexOf("Compaction checkpoint")).toBeLessThan(
      recovery?.durableInstructions?.indexOf("Active run working set") ?? 0
    )
  })

  it("forwards inferred contextual intents and a frozen turn identity", async () => {
    await buildSendOptions({ id: "s1" } as never, "Plot a doughnut chart", undefined, {
      runId: "r1",
      turnId: "t1",
      attemptId: "a2",
    })
    expect(jest.mocked(resolveSendOptions)).toHaveBeenCalledWith(
      expect.objectContaining({
        skillIntents: ["chart"],
        turnId: "t1",
        executionIdentity: expect.objectContaining({ runId: "r1", turnId: "t1", attemptId: "a2" }),
      })
    )
  })

  it("carries routing hints — attachment kinds and transcript depth — into the routing context", async () => {
    await buildSendOptions({ id: "s1" } as never, "Describe this picture", undefined, undefined, {
      attachmentKinds: ["image", "document"],
    })
    expect(jest.mocked(resolveSendOptions)).toHaveBeenCalledWith(
      expect.objectContaining({
        routingContextHint: {
          promptText: "Describe this picture",
          attachmentKinds: ["image", "document"],
          messageCount: 0,
        },
        routingSurface: "chat",
      })
    )
  })

  it("names the Router + Fusion chat surface only for the run-creating caller in the desktop shell", async () => {
    const optIn = { routerFusionSurface: "chat" as const }
    await buildSendOptions({ id: "s1" } as never, "hello", undefined, undefined, undefined, optIn)
    expect(jest.mocked(resolveSendOptions).mock.calls.at(-1)?.[0]).not.toHaveProperty(
      "routerFusionSurface"
    )
    ;(globalThis as { __mockIsTauri?: boolean }).__mockIsTauri = true
    try {
      // A caller that dispatches straight to `sendPrompt` never opts in.
      await buildSendOptions({ id: "s1" } as never, "hello")
      expect(jest.mocked(resolveSendOptions).mock.calls.at(-1)?.[0]).not.toHaveProperty(
        "routerFusionSurface"
      )
      await buildSendOptions({ id: "s1" } as never, "hello", undefined, undefined, undefined, optIn)
    } finally {
      delete (globalThis as { __mockIsTauri?: boolean }).__mockIsTauri
    }
    expect(jest.mocked(resolveSendOptions).mock.calls.at(-1)?.[0]?.routerFusionSurface).toBe("chat")
  })

  it("omits attachmentKinds when no hints are passed but still reports depth", async () => {
    await buildSendOptions({ id: "s1" } as never, "hello")
    const hint = jest.mocked(resolveSendOptions).mock.calls.at(-1)?.[0]?.routingContextHint
    expect(hint).toEqual({ promptText: "hello", messageCount: 0 })
    expect(hint).not.toHaveProperty("attachmentKinds")
  })

  it("keeps routingContextHint absent when there is no user message", async () => {
    await buildSendOptions({ id: "s1" } as never, undefined, undefined, undefined, {
      attachmentKinds: ["image"],
    })
    expect(
      jest.mocked(resolveSendOptions).mock.calls.at(-1)?.[0]?.routingContextHint
    ).toBeUndefined()
  })

  describe("addressed-turn overrides", () => {
    const lastOptions = () => jest.mocked(resolveSendOptions).mock.calls.at(-1)?.[0]
    const session = {
      id: "s-route",
      model: "session-model",
      providerOverride: "openai",
      systemPrompt: "Standing prompt",
    } as never
    const member = {
      id: "__teammate__:tm-1",
      name: "Critic",
      avatarColor: "#000",
      systemPrompt: "You are the critic.",
      model: "member-model",
      createdAt: 0,
      updatedAt: 0,
    } as never

    it("runs on the addressed lane instead of the session's", async () => {
      await buildSendOptions(session, "go", undefined, undefined, undefined, undefined, {
        runtimeRef: { kind: "external", agentId: "codex-1" },
      })
      expect(lastOptions()).toMatchObject({ externalRuntimeId: "codex-1", session })
      await buildSendOptions(session, "go", undefined, undefined, undefined, undefined, {
        runtimeRef: { kind: "builtin" },
      })
      expect(lastOptions()).not.toHaveProperty("externalRuntimeId")
    })

    it("answers as the member: its character, and its prompt over the session's", async () => {
      await buildSendOptions(session, "go", undefined, undefined, undefined, undefined, {
        runtimeRef: { kind: "builtin" },
        character: member,
      })
      const options = lastOptions()
      expect(options?.character).toBe(member)
      expect(options?.session).toMatchObject({ id: "s-route", systemPrompt: undefined })
      // The session keeps its own model unless the member's model is asked to win.
      expect(options?.session).toMatchObject({ model: "session-model", providerOverride: "openai" })
      expect(options).not.toHaveProperty("memberOverride")
    })

    it("lets the member's own model win for the turn, without touching the row", async () => {
      await buildSendOptions(session, "go", undefined, undefined, undefined, undefined, {
        runtimeRef: { kind: "builtin" },
        character: member,
        clearSessionModel: true,
      })
      const options = lastOptions()
      expect(options?.session).toMatchObject({ model: undefined, providerOverride: undefined })
      expect(options?.memberOverride).toEqual({
        characterId: "__teammate__:tm-1",
        modelOverride: "member-model",
      })
      expect((session as { model: string }).model).toBe("session-model")
    })
  })

  it("forwards the durable onboarding request as request-scoped authorization", async () => {
    createOnboardingRequest({
      cardId: "summarize-web",
      sessionId: "onboarding-session",
      skillId: "skill_builtin_cognia_onboarding",
      prompt: "Summarize a web page.",
    })
    await buildSendOptions({ id: "onboarding-session" } as never, "Summarize a web page.")
    expect(jest.mocked(resolveSendOptions)).toHaveBeenCalledWith(
      expect.objectContaining({
        skillIntents: expect.arrayContaining(["onboarding.summarize-web"]),
        requestScopedSkillIds: ["skill_builtin_cognia_onboarding"],
      })
    )
  })
  describe("memory branch binding", () => {
    const lastOptions = () => jest.mocked(resolveSendOptions).mock.calls.at(-1)?.[0]

    beforeEach(() => {
      mockGitStatus.mockReset()
      jest.mocked(useGitStore.getState).mockReturnValue({
        status: { branch: "ui-active-branch" },
        rootDir: "/repos/a",
      } as never)
    })

    it("prefers the execution-context branch pinned at binding time", async () => {
      await buildSendOptions({
        id: "s1",
        projectId: "proj-b",
        executionContext: {
          location: "managedWorktree",
          projectId: "proj-b",
          projectRoot: "/repos/b",
          taskWorkspace: { taskId: "t", workspaceKey: "w" },
          branch: "agent/run-42",
          worktreePath: "/wt/run-42",
        },
      } as never)
      expect(lastOptions()?.memoryBranch).toBe("agent/run-42")
      // The bound answer must not consult the UI store or the git bridge.
      expect(mockGitStatus).not.toHaveBeenCalled()
    })

    it("queries the bound worktree when the context carries no branch", async () => {
      mockGitStatus.mockResolvedValue({ branch: "worktree/leg" })
      await buildSendOptions({
        id: "s1",
        projectId: "proj-b",
        executionContext: {
          location: "managedWorktree",
          projectId: "proj-b",
          projectRoot: "/repos/b",
          taskWorkspace: { taskId: "t", workspaceKey: "w" },
          worktreePath: "/wt/run-42",
        },
      } as never)
      expect(mockGitStatus).toHaveBeenCalledWith("/wt/run-42")
      expect(lastOptions()?.memoryBranch).toBe("worktree/leg")
    })

    it("uses the git store only when its root IS the turn root", async () => {
      await buildSendOptions({ id: "s1", projectId: "proj-a" } as never)
      expect(mockGitStatus).not.toHaveBeenCalled()
      expect(lastOptions()?.memoryBranch).toBe("ui-active-branch")
    })

    it("queries the session's project root rather than a mismatched UI store", async () => {
      // The UI-active project is A but the session belongs to B — the store's
      // "ui-active-branch" describes a different checkout and must be ignored.
      mockGitStatus.mockResolvedValue({ branch: "session-b-branch" })
      await buildSendOptions({ id: "s1", projectId: "proj-b" } as never)
      expect(mockGitStatus).toHaveBeenCalledWith("/repos/b")
      expect(lastOptions()?.memoryBranch).toBe("session-b-branch")
    })

    it("supplies no branch rather than guessing when the bound root is unreadable", async () => {
      mockGitStatus.mockRejectedValue(new Error("not a repo"))
      await buildSendOptions({ id: "s1", projectId: "proj-b" } as never)
      expect(lastOptions()?.memoryBranch).toBeUndefined()
    })
  })

  describe("workspace attribution", () => {
    beforeEach(() => {
      jest.mocked(resolveSendOptions).mockClear()
      jest.mocked(useProjectStore.getState).mockReturnValue({
        projects: [PROJECT_A, PROJECT_B],
        activeProjectId: "proj-a",
      } as never)
    })

    it("runs the turn in the SESSION's workspace, not the UI-active one", async () => {
      await buildSendOptions({ id: "s1", projectId: "proj-b" } as never)
      expect(jest.mocked(resolveSendOptions).mock.calls[0]?.[0]?.activeProject).toMatchObject({
        id: "proj-b",
      })
    })

    it("falls back to the active workspace when the session names none", async () => {
      await buildSendOptions({ id: "s1" } as never)
      expect(jest.mocked(resolveSendOptions).mock.calls[0]?.[0]?.activeProject).toMatchObject({
        id: "proj-a",
      })
    })

    it("refuses to borrow another workspace when the session's is gone", async () => {
      await buildSendOptions({ id: "s1", projectId: "proj-deleted" } as never)
      expect(jest.mocked(resolveSendOptions).mock.calls[0]?.[0]?.activeProject).toBeNull()
    })
  })
})

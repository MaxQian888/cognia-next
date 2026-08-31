import { buildSendOptions, buildWorkingSetPostCompaction } from "./claude-chat-send-options"
import { resolveSendOptions } from "@/lib/claude/build-options"
import { useProjectStore } from "@/stores/project/project-store"
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
  useGitStore: { getState: () => ({ status: null }) },
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
jest.mock("@/lib/tauri", () => ({ isTauri: () => false }))

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

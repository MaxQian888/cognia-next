import type { SandboxPlacementOutcome } from "./environment-placement"
import type { RunEnvironmentSources } from "./run-environment"
import { resolveTaskShellPlacement, type TaskShellPlacementSources } from "./task-shell-placement"
import { createManagedWorkspaceContext } from "@/lib/task-workspace/managed-workspace"

const placement = { kind: "container", spec: { specDigest: "sha256:abc" } } as never

function sources(
  overrides: Partial<TaskShellPlacementSources> = {},
  selected: Awaited<ReturnType<RunEnvironmentSources["selection"]>> = {
    runtime: undefined,
    policy: undefined,
  }
) {
  const base = {
    selection: jest.fn(async () => selected),
  } as unknown as RunEnvironmentSources
  const prepare = jest.fn(
    async (
      _request: Parameters<TaskShellPlacementSources["prepare"]>[0],
      _sources: RunEnvironmentSources
    ): Promise<SandboxPlacementOutcome> => ({ kind: "placed", placement, notices: [] })
  )
  const all: TaskShellPlacementSources = {
    session: async () => ({
      projectId: "legacy",
      executionContext: { projectId: "p1", environmentId: "env-1" } as never,
    }),
    project: async () => ({ roots: [] }) as never,
    prepare,
    runEnvironment: async () => base,
    describe: async () => undefined,
    ...overrides,
  }
  return { all, prepare, base }
}

describe("resolveTaskShellPlacement", () => {
  it("uses only deployment auto selection for a scratch, without Default's roots or approvals", async () => {
    ;(globalThis as Record<string, unknown>).__COGNIA_HEADLESS__ = true
    const project = jest.fn(async () => ({ roots: [{ path: "/other-project" }] }) as never)
    const context = createManagedWorkspaceContext("scratch", 1, "/scratch", "project-default")
    context.environmentId = "default-host-process"
    const { all, prepare, base } = sources(
      {
        session: async () => ({ projectId: "project-default", executionContext: context }),
        project,
      },
      { runtime: { source: { kind: "auto" }, hostProcess: true, updatedAt: 1 }, policy: undefined }
    )
    try {
      await expect(
        resolveTaskShellPlacement({ sessionId: "scratch", workspaceRoot: "/scratch" }, all)
      ).resolves.toBe(placement)
      const [request, scoped] = prepare.mock.calls[0]
      expect(request).toEqual({
        agentId: "task-shell:scratch",
        projectId: "project-default",
        project: null,
        executionRoot: "/scratch",
        surface: "unattended",
      })
      expect(project).not.toHaveBeenCalled()
      await expect(scoped.selection("project-default")).resolves.toEqual({
        runtime: { source: { kind: "auto" }, isolationMinimum: "container", updatedAt: 0 },
        policy: undefined,
      })
      expect(base.selection).not.toHaveBeenCalled()
      await expect(scoped.declarationFiles("/scratch")).resolves.toEqual({
        files: [],
        searched: [],
      })
      await expect(scoped.serverApprovals("project-default")).resolves.toEqual([])
      await expect(scoped.deviceApproval("/other-project")).resolves.toBeUndefined()
    } finally {
      delete (globalThis as Record<string, unknown>).__COGNIA_HEADLESS__
    }
  })

  it("resolves the session's project environment as an unattended run", async () => {
    const { all, prepare } = setup()
    await expect(
      resolveTaskShellPlacement({ sessionId: "s1", workspaceRoot: "/workspaces/p" }, all)
    ).resolves.toBe(placement)
    expect(prepare.mock.calls[0][0]).toEqual({
      agentId: "task-shell:s1",
      projectId: "p1",
      environmentId: "env-1",
      project: { roots: [] },
      executionRoot: "/workspaces/p",
      surface: "unattended",
    })
  })

  it("gives a project with no runtime selection the deployment default", async () => {
    const { all, prepare } = setup()
    await resolveTaskShellPlacement({ sessionId: "s1", workspaceRoot: "/w" }, all)
    const runEnvironment = prepare.mock.calls[0][1]
    await expect(runEnvironment.selection("p1")).resolves.toEqual({
      runtime: { source: { kind: "auto" }, updatedAt: 0 },
      policy: undefined,
    })
  })

  it("keeps a project's own selection", async () => {
    const runtime = { source: { kind: "catalog", catalogEntryId: "node" }, updatedAt: 3 } as const
    const { all, prepare } = sources({}, { runtime, policy: { requiredRuntimeCapabilities: [] } })
    await resolveTaskShellPlacement({ sessionId: "s1", workspaceRoot: "/w" }, all)
    await expect(prepare.mock.calls[0][1].selection("p1")).resolves.toEqual({
      runtime,
      policy: { requiredRuntimeCapabilities: [] },
    })
  })

  it("falls back to the session's legacy project id", async () => {
    const { all, prepare } = sources({ session: async () => ({ projectId: "legacy" }) as never })
    await resolveTaskShellPlacement({ sessionId: "s1", workspaceRoot: "/w" }, all)
    expect(prepare.mock.calls[0][0]).toMatchObject({ projectId: "legacy" })
    expect(prepare.mock.calls[0][0]).not.toHaveProperty("environmentId")
  })

  it("refuses a session that belongs to no project", async () => {
    const { all, prepare } = sources({ session: async () => undefined })
    await expect(
      resolveTaskShellPlacement({ sessionId: "s1", workspaceRoot: "/w" }, all)
    ).rejects.toMatchObject({ code: "placement-unavailable" })
    expect(prepare).not.toHaveBeenCalled()
  })

  it.each<SandboxPlacementOutcome>([
    { kind: "refused", code: "environment_approval_pending", notices: [] },
    { kind: "fallback", code: "sandbox_fallback_pool_disabled", notices: [] },
    { kind: "off" },
  ])("refuses a %s outcome rather than running on the Host", async (outcome) => {
    const { all } = sources({
      prepare: async () => outcome,
      describe: async (o) => (o.kind === "refused" ? "Approve the environment first." : undefined),
    })
    const error = await resolveTaskShellPlacement(
      { sessionId: "s1", workspaceRoot: "/w" },
      all
    ).catch((e: unknown) => e as Error & { code?: string })
    expect(error).toMatchObject({ code: "placement-unavailable" })
    const expected =
      outcome.kind === "refused"
        ? "Approve the environment first."
        : outcome.kind === "fallback"
          ? outcome.code
          : "off"
    expect((error as Error).message).toContain(expected)
  })
})

function setup() {
  return sources()
}

import type { ProjectEnvironmentVersion } from "@/types/project-environment"
import { createLocalTauriExecutionEnvironment } from "./local-tauri-environment"

const profile = (
  overrides: Partial<ProjectEnvironmentVersion> = {}
): ProjectEnvironmentVersion => ({
  id: "env-v1",
  environmentId: "env-1",
  projectId: "project-1",
  version: 1,
  name: "Development",
  setupScript: { default: "pnpm install" },
  actions: [],
  variables: {},
  keyringReferences: [],
  policy: { requiredRuntimeCapabilities: ["filesystem", "process", "terminal", "editor"] },
  createdAt: 1,
  ...overrides,
})

describe("local Tauri AgentTeam execution environment", () => {
  it("fails closed when a requested policy cannot be enforced", async () => {
    const environment = createLocalTauriExecutionEnvironment({
      isTauri: () => true,
      sandboxSupported: false,
      networkPolicySupported: false,
    })
    const secured = profile({
      policy: {
        requiredRuntimeCapabilities: ["filesystem", "sandbox", "network_policy"],
        requireSandbox: true,
        allowedDomains: ["api.github.com"],
      },
    })

    await expect(environment.prepare(secured, "/repo")).rejects.toThrow(/network_policy, sandbox/)
  })

  it("prepares an immutable environment version and exposes takeover surfaces", async () => {
    const executeSetup = jest.fn(async () => ({ success: true, bypassed: false }))
    const settle = jest.fn(async () => [{ path: "src/index.ts", kind: "modified" }])
    const environment = createLocalTauriExecutionEnvironment({
      isTauri: () => true,
      sandboxSupported: true,
      networkPolicySupported: true,
      executeSetup,
      openWorkspace: async () => ({
        executionRoot: "/worktrees/child-1",
        workspaceRunId: "workspace-run-1",
        branch: "codex/child-1",
        settle,
      }),
    })

    const prepared = await environment.prepare(profile(), "/repo")
    const child = await environment.openChild({
      runId: "run-1",
      childRunId: "child-1",
      taskId: "task-1",
      teammateId: "mate-1",
      repositoryPath: "/repo",
      profile: prepared,
    })

    expect(executeSetup).toHaveBeenCalledWith(profile(), "/repo")
    expect(child.executionRoot).toBe("/worktrees/child-1")
    expect(child.branch).toBe("codex/child-1")
    expect(environment.getInteractiveSurfaces("child-1")).toEqual({
      terminal: { cwd: "/worktrees/child-1", sessionScope: "child-1" },
      editor: { root: "/worktrees/child-1" },
      browser: { sessionScope: "child-1" },
    })
    await expect(child.settle("ready")).resolves.toEqual([
      { path: "src/index.ts", kind: "modified" },
    ])
    await environment.dispose("child-1")
    expect(settle).toHaveBeenCalledTimes(1)
  })

  it("uses the host-neutral execution transport outside Tauri", async () => {
    const executeSetup = jest.fn(async () => ({ success: true }))
    const environment = createLocalTauriExecutionEnvironment({
      isTauri: () => false,
      executeSetup,
    })
    await expect(environment.prepare(profile(), "/repo")).resolves.toEqual(
      expect.objectContaining({ executionRoot: "/repo" })
    )
    expect(executeSetup).toHaveBeenCalledWith(profile(), "/repo")
  })
})

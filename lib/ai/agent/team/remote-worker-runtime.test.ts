import {
  RemoteWorkerWaitingError,
  selectRemoteWorker,
  type RemoteWorkerDescriptor,
} from "./remote-worker-runtime"

function worker(
  hostRef: string,
  overrides: Partial<RemoteWorkerDescriptor> = {}
): RemoteWorkerDescriptor {
  return {
    connectionId: `connection:${hostRef}`,
    hostRef,
    online: true,
    activeTurns: 0,
    lastSeenAt: 1,
    manifest: {
      manifestVersion: 1,
      runtime: "cognia-agent",
      models: ["claude-sonnet"],
      hardCapabilities: ["tools", "sandbox:filesystem"],
      maxActiveTurns: 1,
      credentialProfileRefs: ["credential:anthropic"],
      workspaceBindingRefs: ["repository:project:repo"],
      taskWorkspace: { enabled: true },
      sandbox: { capabilities: ["filesystem"] },
      platform: { os: "linux", arch: "x64" },
    },
    ...overrides,
  }
}

describe("remote AgentTeam worker selection", () => {
  const requirements = {
    requiredCapabilities: ["tools"],
    credentialProfileRef: "credential:anthropic",
    workspaceBindingRef: "repository:project:repo",
    requiredSandboxCapabilities: ["filesystem"],
  }

  it("selects the lowest load and breaks ties by stable authenticated hostRef", () => {
    const selected = selectRemoteWorker(
      [worker("device:b"), worker("device:a"), worker("device:c", { activeTurns: 1 })],
      { mode: "auto" },
      requirements
    )
    expect(selected.hostRef).toBe("device:a")
  })

  it("keeps an offline pinned target waiting instead of migrating", () => {
    expect(() =>
      selectRemoteWorker(
        [worker("device:a"), worker("device:b", { online: false })],
        { mode: "pinned", hostRef: "device:b" },
        requirements
      )
    ).toThrow(RemoteWorkerWaitingError)
    try {
      selectRemoteWorker(
        [worker("device:a")],
        { mode: "pinned", hostRef: "device:missing" },
        requirements
      )
    } catch (error) {
      expect(error).toMatchObject({ reason: "pinned_host_offline" })
    }
  })

  it("fails closed before dispatch when capability, credential, workspace, or slots differ", () => {
    const candidates = [
      worker("device:cap", {
        manifest: { ...worker("x").manifest, hardCapabilities: [] },
      }),
      worker("device:credential", {
        manifest: { ...worker("x").manifest, credentialProfileRefs: [] },
      }),
      worker("device:workspace", {
        manifest: { ...worker("x").manifest, workspaceBindingRefs: [] },
      }),
      worker("device:sandbox", {
        manifest: { ...worker("x").manifest, sandbox: { capabilities: [] } },
      }),
      worker("device:full", { activeTurns: 1 }),
    ]
    expect(() => selectRemoteWorker(candidates, { mode: "auto" }, requirements)).toThrow(
      expect.objectContaining({ reason: "no_compatible_capacity" })
    )
  })
})

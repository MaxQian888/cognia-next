import type {
  AcpPermissionRequest,
  ExternalAgentInstance,
  ExternalAgentResult,
} from "@/types/agent/external-agent"
import {
  SelectableIssueLoopDriver,
  ExternalAgentIssueLoopDriver,
  decideIssueLoopPermission,
} from "./external-agent-driver"

const WORKSPACE = "/delivery/o-r-1"

function instance(overrides: Partial<ExternalAgentInstance> = {}): ExternalAgentInstance {
  return {
    config: {
      id: "codex-main",
      name: "Codex",
      protocol: "codex-app-server",
      transport: "stdio",
      enabled: true,
    },
    connectionStatus: "connected",
    status: "ready",
    sessions: new Map(),
    capabilities: {
      toolExecution: true,
      fileOperations: true,
      multiTurn: true,
    },
    validity: {
      executable: true,
      checkedAt: new Date(0),
      source: "connect",
      sessionExtensions: {
        "session/list": { state: "unknown" },
        "session/fork": { state: "unknown" },
        "session/resume": { state: "unknown" },
      },
    },
    connectionAttempts: 0,
    stats: {
      totalExecutions: 0,
      successfulExecutions: 0,
      failedExecutions: 0,
      totalTokensUsed: 0,
      averageResponseTime: 0,
    },
    ...overrides,
  }
}

function result(overrides: Partial<ExternalAgentResult> = {}): ExternalAgentResult {
  return {
    success: true,
    sessionId: "session-1",
    finalResponse: "Done.\n<SUMMARY>Fixed the issue.</SUMMARY>",
    messages: [],
    steps: [],
    toolCalls: [],
    duration: 250,
    ...overrides,
  }
}

function request(overrides: Partial<AcpPermissionRequest> = {}): AcpPermissionRequest {
  return {
    id: "permission-1",
    requestId: "permission-1",
    kind: "execute",
    toolInfo: { id: "shell", name: "Bash" },
    rawInput: { command: "pnpm test", cwd: WORKSPACE },
    ...overrides,
  }
}

describe("ExternalAgentIssueLoopDriver", () => {
  it("executes the exact configured agent with the delivery workspace and trace identity", async () => {
    const configured = instance({ connectionStatus: "disconnected" })
    const manager = {
      getAgent: jest.fn(() => configured),
      connect: jest.fn(async () => undefined),
      execute: jest.fn(async () => result()),
    }
    const signal = new AbortController().signal
    const driver = new ExternalAgentIssueLoopDriver({
      manager,
      runtimeSupportsExternalAgents: () => true,
    })

    const output = await driver.run({
      workspacePath: WORKSPACE,
      repoFullName: "o/r",
      issueNumber: 12,
      issueTitle: "Fix tests",
      issueBody: "The suite is red.",
      externalAgentId: "codex-main",
      workflowRunId: "run-1",
      workflowStepId: "step-2",
      signal,
    })

    expect(manager.connect).toHaveBeenCalledWith("codex-main")
    expect(manager.execute).toHaveBeenCalledWith(
      "codex-main",
      expect.stringContaining("The suite is red."),
      expect.objectContaining({
        workingDirectory: WORKSPACE,
        systemPrompt: expect.stringContaining("<SUMMARY>"),
        permissionMode: "default",
        timeout: 60 * 60_000,
        signal,
        traceContext: expect.objectContaining({
          traceId: "run-1",
          spanId: "step-2",
          metadata: {
            workflowRunId: "run-1",
            workflowStepId: "step-2",
            githubRepo: "o/r",
            githubIssueNumber: 12,
          },
        }),
        onPermissionRequest: expect.any(Function),
      })
    )
    expect(output).toEqual({
      summary: "Fixed the issue.",
      durationMs: 250,
      driverId: "codex-main",
    })
    const executeCalls = (manager.execute as unknown as jest.Mock).mock.calls
    const permissionHandler = executeCalls[0][2]?.onPermissionRequest as
      ((request: AcpPermissionRequest) => Promise<unknown>) | undefined
    expect(await permissionHandler?.(request())).toMatchObject({ granted: true, scope: "once" })
    expect(await permissionHandler?.(request())).toMatchObject({
      granted: false,
      reason: expect.stringMatching(/replay/i),
    })
  })

  it("redacts issue PII before the External Agent model path", async () => {
    const manager = {
      getAgent: jest.fn(() => instance()),
      connect: jest.fn(async () => undefined),
      execute: jest.fn(async () => result()),
    }
    const driver = new ExternalAgentIssueLoopDriver({
      manager,
      runtimeSupportsExternalAgents: () => true,
    })

    await driver.run({
      workspacePath: WORKSPACE,
      repoFullName: "o/r",
      issueNumber: 1,
      issueTitle: "Contact user@example.com",
      issueBody: "",
      externalAgentId: "codex-main",
      signal: new AbortController().signal,
    })

    const prompt = (manager.execute as unknown as jest.Mock).mock.calls[0][1] as string
    expect(prompt).not.toContain("user@example.com")
    expect(prompt).toContain("<EMAIL_")
  })

  it("fails closed for missing, disabled, uncertified, or unsuccessful agents", async () => {
    const scenarios: Array<[string, ExternalAgentInstance | undefined, ExternalAgentResult?]> = [
      ["missing", undefined],
      ["disabled", instance({ config: { ...instance().config, enabled: false } })],
      [
        "uncertified",
        instance({
          validity: {
            ...instance().validity!,
            executable: false,
            blockingReason: "Compatibility check failed.",
          },
        }),
      ],
      ["failed execution", instance(), result({ success: false, error: "connection lost" })],
    ]

    for (const [label, configured, execution] of scenarios) {
      const manager = {
        getAgent: jest.fn(() => configured),
        connect: jest.fn(async () => undefined),
        execute: jest.fn(async () => execution ?? result()),
      }
      const driver = new ExternalAgentIssueLoopDriver({
        manager,
        runtimeSupportsExternalAgents: () => true,
      })
      await expect(
        driver.run({
          workspacePath: WORKSPACE,
          repoFullName: "o/r",
          issueNumber: 1,
          issueTitle: label,
          issueBody: "",
          externalAgentId: "codex-main",
          signal: new AbortController().signal,
        })
      ).rejects.toThrow()
      if (label !== "failed execution") {
        expect(manager.execute).not.toHaveBeenCalled()
      }
    }
  })

  it("never falls back to another agent when the selected agent fails", async () => {
    const manager = {
      getAgent: jest.fn(() => instance()),
      connect: jest.fn(async () => undefined),
      execute: jest.fn(async () => {
        throw new Error("Codex unavailable")
      }),
    }
    const driver = new ExternalAgentIssueLoopDriver({
      manager,
      runtimeSupportsExternalAgents: () => true,
    })

    await expect(
      driver.run({
        workspacePath: WORKSPACE,
        repoFullName: "o/r",
        issueNumber: 1,
        issueTitle: "x",
        issueBody: "",
        externalAgentId: "codex-main",
        signal: new AbortController().signal,
      })
    ).rejects.toThrow(/Codex unavailable/)
    expect(manager.execute).toHaveBeenCalledTimes(1)
    expect(manager.execute).toHaveBeenCalledWith("codex-main", expect.anything(), expect.anything())
  })
})

describe("SelectableIssueLoopDriver", () => {
  const opts = {
    workspacePath: WORKSPACE,
    repoFullName: "o/r",
    issueNumber: 1,
    issueTitle: "x",
    issueBody: "",
    signal: new AbortController().signal,
  }

  it("keeps Claude as the default and selects External Agent only for an explicit id", async () => {
    const sidecar = {
      run: jest.fn(async () => ({
        summary: "Claude",
        durationMs: 1,
        driverId: "claude-code",
      })),
    }
    const external = {
      run: jest.fn(async () => ({
        summary: "Codex",
        durationMs: 2,
        driverId: "codex-main",
      })),
    }
    const driver = new SelectableIssueLoopDriver({ sidecar, external })

    await expect(driver.run(opts)).resolves.toMatchObject({ driverId: "claude-code" })
    await expect(driver.run({ ...opts, externalAgentId: "codex-main" })).resolves.toMatchObject({
      driverId: "codex-main",
    })
    expect(sidecar.run).toHaveBeenCalledTimes(1)
    expect(external.run).toHaveBeenCalledTimes(1)
  })

  it("does not call Claude when the selected External Agent fails", async () => {
    const sidecar = {
      run: jest.fn(async () => ({
        summary: "Claude",
        durationMs: 1,
        driverId: "claude-code",
      })),
    }
    const external = {
      run: jest.fn(async () => {
        throw new Error("Codex failed")
      }),
    }
    const driver = new SelectableIssueLoopDriver({ sidecar, external })

    await expect(driver.run({ ...opts, externalAgentId: "codex-main" })).rejects.toThrow(
      /Codex failed/
    )
    expect(sidecar.run).not.toHaveBeenCalled()
  })
})

describe("decideIssueLoopPermission", () => {
  it.each([
    "git push",
    "git -C /delivery/o-r-1 push origin feature",
    "gh pr create --fill",
    "env gh pr merge 1",
    "bash -c 'git push origin feature'",
    "cmd /c gh pr create --fill",
    "pnpm test && git push",
  ])("denies forbidden shell command %s", (command) => {
    expect(
      decideIssueLoopPermission(request({ rawInput: { command, cwd: WORKSPACE } }), WORKSPACE)
        .granted
    ).toBe(false)
  })

  it("denies uninspectable shell input, unprovable cwd, and permission escalation", () => {
    expect(decideIssueLoopPermission(request({ rawInput: undefined }), WORKSPACE).granted).toBe(
      false
    )
    expect(
      decideIssueLoopPermission(request({ rawInput: { command: "pnpm test" } }), WORKSPACE).granted
    ).toBe(false)
    expect(
      decideIssueLoopPermission(
        request({ toolInfo: { id: "permissions", name: "request_permissions" } }),
        WORKSPACE
      ).granted
    ).toBe(false)
    expect(
      decideIssueLoopPermission(
        request({
          rawInput: {
            command: "pnpm test",
            cwd: WORKSPACE,
            permissionMode: "bypassPermissions",
          },
        }),
        WORKSPACE
      ).granted
    ).toBe(false)
  })

  it("approves safe build, read, and in-workspace edit requests once", () => {
    const safeRequests = [
      request(),
      request({
        kind: "file_read",
        toolInfo: { id: "read", name: "Read" },
        rawInput: { path: `${WORKSPACE}/package.json` },
        locations: [{ path: `${WORKSPACE}/package.json` }],
      }),
      request({
        kind: "file_write",
        toolInfo: { id: "edit", name: "Edit" },
        rawInput: { path: "src/fix.ts" },
        locations: [{ path: "src/fix.ts" }],
      }),
    ]

    for (const safeRequest of safeRequests) {
      expect(decideIssueLoopPermission(safeRequest, WORKSPACE)).toMatchObject({
        requestId: "permission-1",
        granted: true,
        rememberChoice: false,
        scope: "once",
      })
    }
  })

  it("denies writes outside the delivery workspace or without a provable path", () => {
    const outside = request({
      kind: "file_write",
      toolInfo: { id: "edit", name: "Edit" },
      rawInput: { path: "/tmp/escape.ts" },
      locations: [{ path: "/tmp/escape.ts" }],
    })
    const missing = request({
      kind: "file_write",
      toolInfo: { id: "edit", name: "Edit" },
      rawInput: {},
      locations: undefined,
    })

    expect(decideIssueLoopPermission(outside, WORKSPACE).granted).toBe(false)
    expect(decideIssueLoopPermission(missing, WORKSPACE).granted).toBe(false)
  })
})

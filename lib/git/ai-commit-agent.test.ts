import {
  COMMIT_AGENT_TIMEOUT_MS,
  CommitAgentAbortedError,
  CommitAgentFailedError,
  commitMessageTarget,
  decideCommitAgentPermission,
  runCommitMessageAgent,
  type CommitAgentDeps,
} from "./ai-commit-agent"
import type {
  AcpPermissionRequest,
  ExternalAgentEvent,
  ExternalAgentResult,
} from "@/types/agent/external-agent"

function result(overrides: Partial<ExternalAgentResult> = {}): ExternalAgentResult {
  return {
    success: true,
    sessionId: "s1",
    finalResponse: "<commit-message>feat: x</commit-message>",
    messages: [],
    steps: [],
    toolCalls: [],
    duration: 10,
    ...overrides,
  }
}

function delta(text: string, sessionId = "s1"): ExternalAgentEvent {
  return {
    type: "message_delta",
    sessionId,
    timestamp: new Date(0),
    delta: { type: "text", text },
  } as ExternalAgentEvent
}

function deps(overrides: Partial<CommitAgentDeps> = {}): CommitAgentDeps {
  let n = 0
  return {
    executeExternal: jest.fn().mockResolvedValue(result()),
    cancelExternal: jest.fn().mockResolvedValue(undefined),
    executeHost: jest.fn().mockResolvedValue(result()),
    interruptHost: jest.fn().mockResolvedValue(undefined),
    newId: () => `id${++n}`,
    ...overrides,
  }
}

const input = { prompt: "P", systemPrompt: "S" }

describe("commitMessageTarget", () => {
  it("routes a local external agent to the external lane", () => {
    expect(commitMessageTarget("agent", { kind: "external", agentId: "codex" })).toEqual({
      kind: "external",
      agentId: "codex",
    })
  })

  it("routes a host configuration with its admission stamp", () => {
    expect(
      commitMessageTarget(undefined, {
        kind: "host",
        configId: "c1",
        revision: "r2",
        lifecycleGeneration: 3,
        name: "Host Codex",
      })
    ).toEqual({ kind: "host", stamp: { configId: "c1", revision: "r2", lifecycleGeneration: 3 } })
  })

  it("uses the model for the built-in lane", () => {
    expect(commitMessageTarget("agent", { kind: "builtin" })).toEqual({ kind: "model" })
  })

  it("uses the model whenever the source says so", () => {
    expect(commitMessageTarget("model", { kind: "external", agentId: "codex" })).toEqual({
      kind: "model",
    })
  })
})

describe("decideCommitAgentPermission", () => {
  const base = { id: "p1", toolInfo: { name: "tool" } } as unknown as AcpPermissionRequest

  it("allows a read once, with the allow option", () => {
    const decision = decideCommitAgentPermission({
      ...base,
      kind: "read",
      options: [
        { optionId: "a", name: "Allow", kind: "allow_once" },
        { optionId: "r", name: "Reject", kind: "reject_once" },
      ],
    })
    expect(decision).toEqual({ requestId: "p1", granted: true, scope: "once", optionId: "a" })
  })

  it.each(["edit", "execute", "delete", undefined])("refuses a %s request", (kind) => {
    const decision = decideCommitAgentPermission({
      ...base,
      requestId: "rq",
      kind: kind as AcpPermissionRequest["kind"],
      options: [{ optionId: "r", name: "Reject", kind: "reject_once" }],
    })
    expect(decision.granted).toBe(false)
    expect(decision.requestId).toBe("rq")
    expect(decision.optionId).toBe("r")
  })
})

describe("runCommitMessageAgent", () => {
  it("runs a local agent read-only, in a fresh session, inside the repository", async () => {
    const d = deps()
    const out = await runCommitMessageAgent(
      { kind: "external", agentId: "codex" },
      { ...input, workingDirectory: "/repo" },
      d
    )
    expect(out).toBe("<commit-message>feat: x</commit-message>")
    const [prompt, options] = (d.executeExternal as jest.Mock).mock.calls[0]
    expect(prompt).toBe("P")
    expect(options).toMatchObject({
      agentId: "codex",
      systemPrompt: "S",
      permissionMode: "plan",
      resetExternalSession: true,
      timeout: COMMIT_AGENT_TIMEOUT_MS,
      workingDirectory: "/repo",
    })
    const permission = await options.onPermissionRequest({
      id: "x",
      kind: "edit",
      toolInfo: { name: "write" },
    })
    expect(permission.granted).toBe(false)
  })

  it("omits the working directory for a repository it cannot open", async () => {
    const d = deps()
    await runCommitMessageAgent({ kind: "external", agentId: "codex" }, input, d)
    expect((d.executeExternal as jest.Mock).mock.calls[0][1]).not.toHaveProperty("workingDirectory")
  })

  it("streams text deltas as they arrive", async () => {
    const seen: string[] = []
    const d = deps({
      executeExternal: jest.fn(async (_prompt, options) => {
        options.onEvent?.(delta("feat"))
        options.onEvent?.(delta(": y"))
        return result({ finalResponse: "" })
      }),
    })
    const out = await runCommitMessageAgent(
      { kind: "external", agentId: "codex" },
      {
        ...input,
        onText: (text) => seen.push(text),
      },
      d
    )
    expect(seen).toEqual(["feat", "feat: y"])
    // An empty final answer falls back to what streamed.
    expect(out).toBe("feat: y")
  })

  it("runs a host configuration on its own chat id and run id", async () => {
    const d = deps()
    await runCommitMessageAgent(
      { kind: "host", stamp: { configId: "c", revision: "r", lifecycleGeneration: 1 } },
      input,
      d
    )
    const [, options] = (d.executeHost as jest.Mock).mock.calls[0]
    expect(options.stamp).toEqual({ configId: "c", revision: "r", lifecycleGeneration: 1 })
    expect(options.chatSessionId).toMatch(/^source-control:commit:/)
    expect(options.newRunId()).toMatch(/^rer_/)
  })

  it("fails when the agent is unavailable", async () => {
    const d = deps({ executeExternal: jest.fn().mockResolvedValue(null) })
    await expect(
      runCommitMessageAgent({ kind: "external", agentId: "codex" }, input, d)
    ).rejects.toBeInstanceOf(CommitAgentFailedError)
  })

  it("fails with the agent's own error", async () => {
    const d = deps({
      executeExternal: jest.fn().mockResolvedValue(result({ success: false, error: "auth" })),
    })
    await expect(
      runCommitMessageAgent({ kind: "external", agentId: "codex" }, input, d)
    ).rejects.toThrow("auth")
  })

  it("cancels a local agent's session at once", async () => {
    const controller = new AbortController()
    const d = deps({
      executeExternal: jest.fn((_prompt, options) => {
        options.onEvent?.(delta("partial", "sess-9"))
        return new Promise<ExternalAgentResult>(() => {})
      }),
    })
    const run = runCommitMessageAgent(
      { kind: "external", agentId: "codex" },
      { ...input, signal: controller.signal },
      d
    )
    controller.abort()
    await expect(run).rejects.toBeInstanceOf(CommitAgentAbortedError)
    expect(d.cancelExternal).toHaveBeenCalledWith("codex", "sess-9")
  })

  it("interrupts a host run by its run id", async () => {
    const controller = new AbortController()
    let runId = ""
    const d = deps({
      executeHost: jest.fn((_prompt, options) => {
        runId = options.newRunId?.() ?? ""
        return new Promise<ExternalAgentResult>(() => {})
      }),
    })
    const run = runCommitMessageAgent(
      { kind: "host", stamp: { configId: "c", revision: "r", lifecycleGeneration: 1 } },
      { ...input, signal: controller.signal },
      d
    )
    controller.abort()
    await expect(run).rejects.toBeInstanceOf(CommitAgentAbortedError)
    expect(d.interruptHost).toHaveBeenCalledWith(runId)
  })

  it("refuses to start when already cancelled", async () => {
    const controller = new AbortController()
    controller.abort()
    const d = deps()
    await expect(
      runCommitMessageAgent(
        { kind: "external", agentId: "codex" },
        { ...input, signal: controller.signal },
        d
      )
    ).rejects.toBeInstanceOf(CommitAgentAbortedError)
    expect(d.executeExternal).not.toHaveBeenCalled()
  })
})

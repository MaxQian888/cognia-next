/**
 * @jest-environment node
 */
import type { PluginToolDispatchDeps } from "../plugin/plugin-tool-dispatch"
import type { PluginToolExecRequest } from "@/lib/claude/plugin-tool-ipc"
import { runCliSubagent, type RunCliSubagentDeps } from "./subagent-runner"
import type { BuildOptionsContext } from "@/lib/claude/build-options"
import type { SendOptions } from "@cognia/agent-config-types"
import type { RunAndCaptureResult } from "@/lib/claude/run-and-capture"
import type { PluginSubagentDef } from "@/types/plugin/plugin-subagent"
import { DEFAULT_RESOLVED_CONFIG, type ResolvedConfig } from "../config/schema"
import { DEFAULT_BUILTIN_TOOLS } from "@cognia/agent-config-types"
import { createPermissionGate } from "./permission-gate"
import { loadSkillResourceForSession } from "@/lib/skills/runtime-loader"

// Mock the live-sidecar default collaborators so the "no injected deps" path —
// where runCliSubagent falls back to them — is exercisable without a sidecar.
// Tests that inject their own deps bypass these entirely (injection wins).
jest.mock("@/lib/claude/build-options", () => ({
  resolveSendOptions: jest.fn(async () => ({ provider: "opencode-go" })),
}))
jest.mock("@/lib/claude/run-and-capture", () => ({
  RunAndCaptureError: jest.requireActual("@/lib/claude/run-and-capture").RunAndCaptureError,
  runAndCaptureAssistantReply: jest.fn(async () => ({
    text: "from default capture",
    messageId: "m",
    a2uiSurfaces: {},
    a2uiSurfaceOrder: [],
  })),
}))
jest.mock("@/lib/claude/ipc", () => ({ closeSession: jest.fn(async () => undefined) }))
jest.mock("../plugin/plugin-tool-dispatch", () => ({
  subscribePluginToolDispatch: jest.fn(async () => jest.fn()),
}))
jest.mock("./configured-plugin-tool-handle", () => ({
  makeConfiguredCliPluginToolHandle: jest.fn(() =>
    jest.fn(async (request) => ({
      type: "plugin_tool_response",
      sessionId: request.sessionId,
      toolUseId: request.toolUseId,
      result: "child tool result",
    }))
  ),
}))
jest.mock("./cli-host-runtime", () => ({
  bindCliSessionHostRuntime: jest.fn(() => jest.fn()),
}))
jest.mock("../plugin/plugin-runtime", () => ({
  ensurePluginRuntime: jest.fn(async () => ({ ok: true })),
}))
jest.mock("../db/bootstrap", () => ({
  ensureCliDb: jest.fn(async () => undefined),
  cliStoreMayHoldRows: () => false,
  CliDbSnapshotError: class extends Error {},
}))

function cfg(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return {
    ...DEFAULT_RESOLVED_CONFIG,
    builtinTools: { ...DEFAULT_BUILTIN_TOOLS },
    providers: { "opencode-go": { apiKey: "k" } },
    provider: "opencode-go",
    cwd: "/work",
    model: "parent-model",
    ...overrides,
  }
}

const def = (overrides: Partial<PluginSubagentDef> = {}): PluginSubagentDef => ({
  id: "reviewer",
  name: "reviewer",
  description: "reviews",
  prompt: "You are a reviewer.",
  ...overrides,
})

function captureResult(overrides: Partial<RunAndCaptureResult> = {}): RunAndCaptureResult {
  return { text: "reviewed", messageId: "m", a2uiSurfaces: {}, a2uiSurfaceOrder: [], ...overrides }
}

describe("runCliSubagent", () => {
  it("drains a nested child host call before releasing its session", async () => {
    const { subscribePluginToolDispatch } = jest.requireMock("../plugin/plugin-tool-dispatch")
    const { makeConfiguredCliPluginToolHandle } = jest.requireMock(
      "./configured-plugin-tool-handle"
    )
    let finish!: () => void
    const pendingWrite = new Promise<void>((resolve) => {
      finish = resolve
    })
    makeConfiguredCliPluginToolHandle.mockReturnValueOnce(
      jest.fn(async () => {
        await pendingWrite
        return { result: "saved" }
      })
    )
    let started!: () => void
    const accepted = new Promise<void>((resolve) => {
      started = resolve
    })
    let hostCall!: Promise<unknown>
    const deps = setupDeps()
    deps.capture = async (id) => {
      const handle = subscribePluginToolDispatch.mock.calls.at(-1)[0].handle
      hostCall = handle({ sessionId: id, toolUseId: "nested", name: "dispatch_agent", args: {} })
      await new Promise((resolve) => setImmediate(resolve))
      started()
      return captureResult()
    }
    const run = runCliSubagent(def(), "go", "parent", deps)
    await accepted
    expect(deps.closeSession).not.toHaveBeenCalled()
    finish()
    await Promise.all([run, hostCall])
    expect(deps.closeSession).toHaveBeenCalledTimes(1)
  })
  it("returns completed evidence from a cancelled child capture and still retires its session", async () => {
    const controller = new AbortController()
    const { RunAndCaptureError } = jest.requireActual("@/lib/claude/run-and-capture")
    const deps = { ...setupDeps(), signal: controller.signal }
    deps.capture = async () => {
      controller.abort()
      throw new RunAndCaptureError("cancelled", "aborted", {
        partial: {
          text: "partial report",
          continuationContext: "DONE_FACT; NEXT_FILE=/remaining.ts",
        },
      })
    }
    await expect(runCliSubagent(def(), "go", "parent", deps)).resolves.toMatchObject({
      finishReason: "interrupted",
      text: expect.stringContaining("DONE_FACT"),
    })
    expect(deps.closeSession).toHaveBeenCalledTimes(1)
  })
  it.each([false, true])(
    "waits for shared approvals before a child host call (cancel=%s)",
    async (cancel) => {
      const { subscribePluginToolDispatch } = jest.requireMock("../plugin/plugin-tool-dispatch")
      const { makeConfiguredCliPluginToolHandle } = jest.requireMock(
        "./configured-plugin-tool-handle"
      )
      let bridge: { handle: (r: unknown) => Promise<unknown> }
      subscribePluginToolDispatch.mockImplementationOnce(async (value: PluginToolDispatchDeps) => {
        bridge = value as typeof bridge
        return jest.fn()
      })
      let release!: () => void
      const approved = new Promise<void>((resolve) => (release = resolve))
      const controller = new AbortController()
      const deps = { ...setupDeps(), signal: controller.signal, awaitApprovals: () => approved }
      deps.capture = async (id) => {
        const execute = makeConfiguredCliPluginToolHandle.mock.results.at(-1).value
        const pending = bridge.handle({ sessionId: id, toolUseId: "host", args: {} })
        await Promise.resolve()
        expect(execute).not.toHaveBeenCalled()
        if (cancel) controller.abort()
        else release()
        await expect(pending).resolves.toMatchObject(
          cancel ? { error: expect.stringMatching(/cancel/i) } : { result: "child tool result" }
        )
        expect(execute).toHaveBeenCalledTimes(cancel ? 0 : 1)
        return captureResult()
      }
      await runCliSubagent(def(), "go", "parent", deps)
      release()
    }
  )
  it("finishes every child teardown even when detaching the bridge throws", async () => {
    const { subscribePluginToolDispatch } = jest.requireMock("../plugin/plugin-tool-dispatch")
    const { bindCliSessionHostRuntime } = jest.requireMock("./cli-host-runtime")
    subscribePluginToolDispatch.mockResolvedValueOnce(() => {
      throw new Error("detach failed")
    })
    const unregister = jest.fn()
    const deps = { ...setupDeps(), nesting: { manifest: null, register: jest.fn(), unregister } }
    await expect(runCliSubagent(def(), "go", "parent", deps)).resolves.toMatchObject({
      text: "reviewed",
    })
    expect(unregister).toHaveBeenCalledWith("parent::sub-cancel-test")
    expect(deps.closeSession).toHaveBeenCalledWith("parent::sub-cancel-test")
    expect(bindCliSessionHostRuntime.mock.results.at(-1).value).toHaveBeenCalledTimes(1)
    await expect(
      loadSkillResourceForSession("parent::sub-cancel-test", "skill", "reference.md")
    ).resolves.toMatchObject({ ok: false, code: "missing_context" })
  })
  it("advertises scoped child skills and releases their resource context on completion", async () => {
    const deps = setupDeps()
    const scope = {
      sessionId: "parent::sub-cancel-test",
      turnId: "parent::sub-cancel-test:t0",
      attemptId: "parent::sub-cancel-test:t0:a0",
    }
    deps.resolveOptions = async (ctx) => {
      ctx.onResolvedSkillLoadScope?.({
        allowedSkillIds: ["child-skill"],
        explicitSkillIds: [],
        allowDisabledSkillIds: [],
      })
      return {}
    }
    deps.resolveSkillIds = () => ["child-skill"]
    deps.resolveLoadableSkills = async () => [{ id: "child-skill", name: "Workflow" }]
    const resources = {
      listResources: async () => [
        {
          id: "r",
          skillId: "child-skill",
          path: "references/node-types.md",
          name: "test",
          kind: "reference" as const,
          content: "CHILD_SKILL_RESOURCE",
          createdAt: 0,
          updatedAt: 0,
        },
      ],
      recordUsage: async () => undefined,
    }
    deps.capture = async (_id, _prompt, options) => {
      expect(options!.pluginTools?.map((t) => t.name)).toEqual(
        expect.arrayContaining(["load_skill", "load_skill_resource"])
      )
      const loaded = await loadSkillResourceForSession(
        scope,
        "child-skill",
        "references/node-types.md",
        0,
        100,
        resources
      )
      expect(loaded.ok ? loaded.content : loaded).toBe("CHILD_SKILL_RESOURCE")
      await expect(
        loadSkillResourceForSession(
          scope,
          "builtin:ocr",
          "references/node-types.md",
          0,
          100,
          resources
        )
      ).resolves.toMatchObject({ ok: false, code: "out_of_scope" })
      await expect(
        loadSkillResourceForSession(
          { ...scope, attemptId: "stale" },
          "child-skill",
          "references/node-types.md",
          0,
          100,
          resources
        )
      ).resolves.toMatchObject({ ok: false, code: "stale_context" })
      return captureResult()
    }
    await runCliSubagent(def(), "go", "parent", deps)
    await expect(
      loadSkillResourceForSession(
        scope,
        "child-skill",
        "references/node-types.md",
        0,
        100,
        resources
      )
    ).resolves.toMatchObject({ ok: false, code: "missing_context" })
  })

  it("closes and releases a child when subscribing its tool bridge fails", async () => {
    const { subscribePluginToolDispatch } = jest.requireMock("../plugin/plugin-tool-dispatch")
    const { bindCliSessionHostRuntime } = jest.requireMock("./cli-host-runtime")
    subscribePluginToolDispatch.mockRejectedValueOnce(new Error("bridge unavailable"))
    const deps = setupDeps()
    await expect(runCliSubagent(def(), "go", "parent", deps)).rejects.toThrow("bridge unavailable")
    expect(deps.capture).not.toHaveBeenCalled()
    expect(deps.closeSession).toHaveBeenCalledWith("parent::sub-cancel-test")
    expect(bindCliSessionHostRuntime.mock.results.at(-1).value).toHaveBeenCalledTimes(1)
  })

  it("aborts a pending child host call without cancelling a sibling bridge", async () => {
    const { subscribePluginToolDispatch } = jest.requireMock("../plugin/plugin-tool-dispatch")
    const { makeConfiguredCliPluginToolHandle } = jest.requireMock(
      "./configured-plugin-tool-handle"
    )
    const bridges = new Map()
    const disposers = new Map()
    subscribePluginToolDispatch.mockImplementation(async (value: PluginToolDispatchDeps) => {
      bridges.set(value.sessionId, value)
      const dispose = jest.fn()
      disposers.set(value.sessionId, dispose)
      return dispose
    })
    makeConfiguredCliPluginToolHandle.mockImplementationOnce(
      () => async (request: PluginToolExecRequest) => {
        await new Promise<void>((resolve) =>
          request.abortSignal!.addEventListener("abort", () => resolve(), { once: true })
        )
        return { error: "cancelled" }
      }
    )
    const controller = new AbortController()
    let began: () => void
    const started = new Promise<void>((resolve) => (began = resolve))
    const first = runCliSubagent(def(), "go", "parent", {
      ...setupDeps(),
      mintId: () => "one",
      signal: controller.signal,
      capture: async (id) => {
        const pending = bridges.get(id).handle({ sessionId: id, toolUseId: "same", args: {} })
        began()
        await pending
        return captureResult()
      },
    })
    await started
    await runCliSubagent(def(), "sibling", "parent", {
      ...setupDeps(),
      mintId: () => "two",
      capture: async (id) => {
        controller.abort()
        await first
        expect(disposers.get(id)).not.toHaveBeenCalled()
        expect(
          await bridges.get(id).handle({ sessionId: id, toolUseId: "same", args: {} })
        ).toMatchObject({ result: "child tool result" })
        return captureResult()
      },
    })
    expect(disposers.get("parent::sub-one")).toHaveBeenCalledTimes(1)
    expect(disposers.get("parent::sub-two")).toHaveBeenCalledTimes(1)
    subscribePluginToolDispatch.mockImplementation(async () => jest.fn())
  })
  it("owns an exact-id plugin bridge and child host config until capture settles", async () => {
    const { subscribePluginToolDispatch } = jest.requireMock("../plugin/plugin-tool-dispatch")
    const { bindCliSessionHostRuntime } = jest.requireMock("./cli-host-runtime")
    const { makeConfiguredCliPluginToolHandle } = jest.requireMock(
      "./configured-plugin-tool-handle"
    )
    subscribePluginToolDispatch.mockClear()
    bindCliSessionHostRuntime.mockClear()
    makeConfiguredCliPluginToolHandle.mockClear()
    const deps = setupDeps()
    let bridge: { sessionId: string; handle: (request: unknown) => Promise<unknown> }
    const unsubscribe = jest.fn()
    subscribePluginToolDispatch.mockImplementationOnce(async (value: PluginToolDispatchDeps) => {
      bridge = value as typeof bridge
      return unsubscribe
    })
    deps.capture = async (id, _prompt, options) => {
      expect(bridge.sessionId).toBe(id)
      expect(bindCliSessionHostRuntime).toHaveBeenCalledWith(
        expect.objectContaining({ cwd: "/work", model: "child-model" }),
        id
      )
      expect(makeConfiguredCliPluginToolHandle).toHaveBeenCalledWith(
        expect.objectContaining({ model: "child-model" })
      )
      const request = {
        sessionId: id,
        toolUseId: "tool-1",
        toolName: "plugin_probe",
        args: {},
        turnId: options!.turnId,
      }
      expect(await bridge.handle(request)).toMatchObject({ result: "child tool result" })
      expect(await bridge.handle({ ...request, turnId: "stale" })).toMatchObject({
        error: expect.stringMatching(/inactive|cancel/i),
      })
      expect(unsubscribe).not.toHaveBeenCalled()
      return captureResult()
    }
    await runCliSubagent(def({ model: "child-model" }), "go", "parent", deps)
    expect(unsubscribe).toHaveBeenCalledTimes(1)
    expect(bindCliSessionHostRuntime.mock.results.at(-1).value).toHaveBeenCalledTimes(1)
    expect(
      await bridge!.handle({ sessionId: bridge!.sessionId, toolUseId: "late", args: {} })
    ).toMatchObject({ error: expect.stringMatching(/inactive|cancel/i) })
  })

  it("releases the child bridge and host binding when capture throws", async () => {
    const { subscribePluginToolDispatch } = jest.requireMock("../plugin/plugin-tool-dispatch")
    const { bindCliSessionHostRuntime } = jest.requireMock("./cli-host-runtime")
    const unsubscribe = jest.fn()
    subscribePluginToolDispatch.mockResolvedValueOnce(unsubscribe)
    const deps = setupDeps()
    deps.capture = jest.fn(async () => {
      throw new Error("capture failed")
    })
    await expect(runCliSubagent(def(), "go", "parent", deps)).rejects.toThrow("capture failed")
    expect(unsubscribe).toHaveBeenCalledTimes(1)
    expect(bindCliSessionHostRuntime.mock.results.at(-1).value).toHaveBeenCalledTimes(1)
    expect(deps.closeSession).toHaveBeenCalledWith("parent::sub-cancel-test")
  })
  it("carries observed tool evidence into the incomplete subagent report", async () => {
    const deps = setupDeps()
    const capture = jest.fn().mockResolvedValue(
      captureResult({
        text: "budget reached",
        resultSubtype: "error_max_turns",
        budgetContinuationContext: "Recorded tool evidence: FACT_FIRST; NEXT_FILE=/chapter-23",
      })
    )
    const result = await runCliSubagent(def(), "research", "parent", {
      ...deps,
      capture,
      closeSession: jest.fn(async () => undefined),
    })
    expect(result.text).toContain("FACT_FIRST")
    expect(result.text).toContain("NEXT_FILE=/chapter-23")
    expect(capture.mock.calls[0][3]).toMatchObject({ preserveBudgetEvidence: true })
  })

  function setupDeps(): RunCliSubagentDeps {
    return {
      config: cfg(),
      home: "/unused",
      cwd: "/work",
      gate: createPermissionGate({ yes: true }),
      mcpServers: [],
      approvedTools: new Set(),
      disabledMcpTools: new Set(),
      resolveOptions: jest.fn(async () => ({})),
      resolveHooks: () => undefined,
      capture: jest.fn(async () => captureResult()),
      closeSession: jest.fn(async () => undefined),
      mintId: () => "cancel-test",
    }
  }

  it("does not resolve options or start a child for a pre-canceled dispatch", async () => {
    const deps = setupDeps()
    const controller = new AbortController()
    controller.abort()
    await expect(
      runCliSubagent(def(), "go", "parent", { ...deps, signal: controller.signal })
    ).rejects.toMatchObject({ name: "AbortError" })
    expect(deps.resolveOptions).not.toHaveBeenCalled()
    expect(deps.capture).not.toHaveBeenCalled()
  })

  it("uses the assigned child working directory without mutating the parent config", async () => {
    const deps = setupDeps()
    deps.cwd = "/work/child"
    await runCliSubagent(def(), "go", "parent", deps)
    expect(deps.resolveOptions).toHaveBeenCalledWith(
      expect.objectContaining({ session: expect.objectContaining({ workingDir: "/work/child" }) })
    )
    expect(deps.config.cwd).toBe("/work")
  })

  it("does not start or register a child canceled while options resolve", async () => {
    const deps = setupDeps()
    const controller = new AbortController()
    const register = jest.fn()
    deps.resolveOptions = async () => {
      controller.abort()
      return {}
    }
    await expect(
      runCliSubagent(def(), "go", "parent", {
        ...deps,
        signal: controller.signal,
        nesting: { manifest: null, register, unregister: jest.fn() },
      })
    ).rejects.toMatchObject({ name: "AbortError" })
    expect(register).not.toHaveBeenCalled()
    expect(deps.capture).not.toHaveBeenCalled()
  })

  it("cleans up partial nested registration when registration throws", async () => {
    const deps = setupDeps()
    const unregister = jest.fn()
    await expect(
      runCliSubagent(def(), "go", "parent", {
        ...deps,
        nesting: {
          manifest: null,
          register: () => {
            throw new Error("registration failed")
          },
          unregister,
        },
      })
    ).rejects.toThrow("registration failed")
    expect(unregister).toHaveBeenCalledWith("parent::sub-cancel-test")
    expect(deps.closeSession).toHaveBeenCalledWith("parent::sub-cancel-test")
    expect(deps.capture).not.toHaveBeenCalled()
  })

  it("does not forward an approval that arrives after the child was canceled", async () => {
    const deps = setupDeps()
    const controller = new AbortController()
    deps.signal = controller.signal
    deps.gate = async () => {
      controller.abort()
      return { decision: "allow" }
    }
    deps.capture = async (_id, _prompt, _options, captureOptions) => {
      await captureOptions!.onPermissionRequest!({ toolName: "write", input: {} } as never)
      return captureResult()
    }
    await expect(runCliSubagent(def(), "go", "parent", deps)).rejects.toMatchObject({
      name: "AbortError",
    })
    expect(deps.closeSession).toHaveBeenCalled()
  })

  it("runs the subagent over a fresh child session and maps the result", async () => {
    let ctxSeen: BuildOptionsContext | null = null
    const capture = jest.fn().mockResolvedValue(
      captureResult({
        text: "looks good",
        usage: { inputTokens: 10, outputTokens: 5 },
        resultSubtype: "success",
      })
    )
    const closeSession = jest.fn().mockResolvedValue(undefined)
    const gate = createPermissionGate({ yes: true })

    const r = await runCliSubagent(
      def({ model: "sub-model", tools: ["Read"] }),
      "check it",
      "parent",
      {
        config: cfg(),
        home: "/home/.cognia",
        cwd: "/work",
        gate,
        mcpServers: [],
        approvedTools: new Set(["mcp__cognia-tools__bash"]),
        disabledMcpTools: new Set(["mcp__s__x"]),
        resolveOptions: async (ctx) => {
          ctxSeen = ctx
          return { model: ctx.session?.model, provider: "opencode-go" } as unknown as SendOptions
        },
        capture,
        closeSession,
        now: () => 1234,
        mintId: () => "abcd",
      }
    )

    // Child session id namespaced under the parent.
    expect(capture).toHaveBeenCalledTimes(1)
    const [childId, prompt, sendOptions, capOpts] = capture.mock.calls[0]
    expect(childId).toBe("parent::sub-abcd")
    expect(prompt).toBe("check it")

    // Child config: subagent identity is the system prompt, model + tools overlaid,
    // outputStyle dropped (so the parent's response-mode append never leaks in).
    const systemPrompt = ctxSeen!.session?.systemPrompt ?? ""
    expect(systemPrompt.startsWith("You are a reviewer.")).toBe(true)
    // Framed: the child learns its cwd and date, the dispatched-subagent
    // contract, and the CLI's own tool rules (no identity line, no tone block).
    expect(systemPrompt).toContain("<env>\nWorking directory: /work")
    expect(systemPrompt).toContain("<subagent_contract>")
    expect(systemPrompt).toContain("Tool usage:")
    expect(systemPrompt).not.toContain("You are Cognia's command-line coding agent")
    expect(ctxSeen!.session?.model).toBe("sub-model")
    expect(ctxSeen!.character?.allowedTools).toEqual(["Read"])

    // Auto-approve + disabled overlay applied to the child's send options.
    expect((sendOptions as SendOptions).suppressApprovalForTools).not.toContain(
      "mcp__cognia-tools__bash"
    )
    expect((sendOptions as SendOptions).disallowedTools).toContain("mcp__s__x")

    // The parent turn's gate answers the subagent's tool approvals.
    const permission = (
      capOpts as {
        onPermissionRequest: (req: {
          toolName: string
          input: object
        }) => Promise<{ decision: string }>
      }
    ).onPermissionRequest
    expect(await permission({ toolName: "mcp__cognia-tools__bash", input: {} })).toEqual({
      decision: "allow",
    })
    expect(await permission({ toolName: "unapproved", input: {} })).toEqual(
      await gate({ toolName: "unapproved", input: {} } as never)
    )

    // Child session retired afterwards.
    expect(closeSession).toHaveBeenCalledWith("parent::sub-abcd")

    expect(r).toEqual({
      text: "looks good",
      usage: { inputTokens: 10, outputTokens: 5 },
      finishReason: "success",
    })
  })

  it("advertises the nesting manifest and registers/retires the child dispatch context", async () => {
    const manifest = { name: "dispatch_agent", description: "d", input_schema: {} }
    const register = jest.fn()
    const unregister = jest.fn()
    const capture = jest.fn(async (...args: unknown[]) => {
      // The context must be registered BEFORE the turn runs (a mid-run
      // dispatch_agent call resolves it), and retired only after.
      expect(register).toHaveBeenCalledWith(args[0])
      expect(unregister).not.toHaveBeenCalled()
      return captureResult()
    })
    await runCliSubagent(def(), "go", "parent", {
      config: cfg(),
      home: "/h",
      cwd: "/work",
      gate: createPermissionGate({ yes: true }),
      mcpServers: [],
      approvedTools: new Set(),
      disabledMcpTools: new Set(),
      resolveOptions: async () => ({ provider: "opencode-go" }) as unknown as SendOptions,
      capture,
      closeSession: async () => undefined,
      mintId: () => "kid",
      nesting: {
        manifest: manifest as never,
        register,
        unregister,
      },
    })
    const sendOptions = capture.mock.calls[0][2] as SendOptions
    expect(sendOptions.pluginTools).toEqual(expect.arrayContaining([manifest]))
    expect(register).toHaveBeenCalledWith("parent::sub-kid")
    expect(unregister).toHaveBeenCalledWith("parent::sub-kid")
  })

  it("retires the child dispatch context even when the turn throws, without masking the error", async () => {
    const unregister = jest.fn()
    await expect(
      runCliSubagent(def(), "go", "parent", {
        config: cfg(),
        home: "/h",
        cwd: "/work",
        gate: createPermissionGate({ yes: true }),
        mcpServers: [],
        approvedTools: new Set(),
        disabledMcpTools: new Set(),
        resolveOptions: async () => ({}) as unknown as SendOptions,
        capture: async () => {
          throw new Error("turn boom")
        },
        closeSession: async () => undefined,
        mintId: () => "kid",
        nesting: {
          manifest: null,
          register: jest.fn(),
          unregister,
        },
      })
    ).rejects.toThrow("turn boom")
    expect(unregister).toHaveBeenCalledWith("parent::sub-kid")
  })

  it("appends no manifest (and never registers) when nesting is omitted — the child is a leaf", async () => {
    const capture = jest.fn(async (..._args: unknown[]) => captureResult())
    await runCliSubagent(def(), "go", "parent", {
      config: cfg(),
      home: "/h",
      cwd: "/work",
      gate: createPermissionGate({ yes: true }),
      mcpServers: [],
      approvedTools: new Set(),
      disabledMcpTools: new Set(),
      resolveOptions: async () => ({}) as unknown as SendOptions,
      capture,
      closeSession: async () => undefined,
      mintId: () => "kid",
    })
    const sendOptions = capture.mock.calls[0]![2] as unknown as SendOptions
    expect(sendOptions.pluginTools).toBeUndefined()
  })

  it("uses def.maxTurns as the step budget, else inherits the config aiSdkMaxSteps", async () => {
    const capture = jest.fn().mockResolvedValue(captureResult())
    const base = {
      config: cfg({ aiSdkMaxSteps: 200 }),
      home: "/h",
      cwd: "/work",
      gate: createPermissionGate({ yes: true }),
      mcpServers: [],
      approvedTools: new Set<string>(),
      disabledMcpTools: new Set<string>(),
      resolveOptions: async () => ({ provider: "opencode-go" }) as unknown as SendOptions,
      capture,
      closeSession: jest.fn().mockResolvedValue(undefined),
      mintId: () => "x",
    }

    await runCliSubagent(def({ maxTurns: 7 }), "go", "p", base)
    expect((capture.mock.calls[0][2] as SendOptions).maxTurns).toBe(7)

    await runCliSubagent(def(), "go", "p", base)
    expect((capture.mock.calls[1][2] as SendOptions).aiSdkMaxSteps).toBe(200)
    expect((capture.mock.calls[1][2] as SendOptions).maxTurns).toBeUndefined()
  })

  it("runs with no wall-clock and the generous subagent idle window", async () => {
    const capture = jest.fn().mockResolvedValue(captureResult())
    await runCliSubagent(def(), "go", "p", {
      config: cfg({ streamIdleTimeoutMs: 60_000, subagentStreamIdleTimeoutMs: 240_000 }),
      home: "/h",
      cwd: "/work",
      gate: createPermissionGate({ yes: true }),
      mcpServers: [],
      approvedTools: new Set<string>(),
      disabledMcpTools: new Set<string>(),
      resolveOptions: async () => ({ provider: "opencode-go" }) as unknown as SendOptions,
      capture,
      closeSession: jest.fn().mockResolvedValue(undefined),
      mintId: () => "x",
    })
    const capOpts = capture.mock.calls[0][3] as { timeoutMs?: number; idleTimeoutMs?: number }
    // No hidden 5-minute wall-clock (a long subagent must not be killed), and the
    // generous subagent idle — NOT the interactive 60s — bounds a dead stream.
    expect(capOpts.timeoutMs).toBe(0)
    expect(capOpts.idleTimeoutMs).toBe(240_000)
  })

  it("falls back to the interactive idle when no subagent idle is configured", async () => {
    const capture = jest.fn().mockResolvedValue(captureResult())
    await runCliSubagent(def(), "go", "p", {
      config: cfg({ streamIdleTimeoutMs: 90_000, subagentStreamIdleTimeoutMs: undefined }),
      home: "/h",
      cwd: "/work",
      gate: createPermissionGate({ yes: true }),
      mcpServers: [],
      approvedTools: new Set<string>(),
      disabledMcpTools: new Set<string>(),
      resolveOptions: async () => ({ provider: "opencode-go" }) as unknown as SendOptions,
      capture,
      closeSession: jest.fn().mockResolvedValue(undefined),
      mintId: () => "x",
    })
    expect((capture.mock.calls[0][3] as { idleTimeoutMs?: number }).idleTimeoutMs).toBe(90_000)
  })

  it("inherits the parent config's toolExecutionTimeoutMs into the child sendOptions", async () => {
    const capture = jest.fn().mockResolvedValue(captureResult())
    await runCliSubagent(def(), "go", "p", {
      config: cfg({ toolExecutionTimeoutMs: 30_000 }),
      home: "/h",
      cwd: "/work",
      gate: createPermissionGate({ yes: true }),
      mcpServers: [],
      approvedTools: new Set<string>(),
      disabledMcpTools: new Set<string>(),
      // resolveOptions omits it, so the child inherits the parent config value.
      resolveOptions: async () => ({ provider: "opencode-go" }) as unknown as SendOptions,
      capture,
      closeSession: jest.fn().mockResolvedValue(undefined),
      mintId: () => "x",
    })
    expect((capture.mock.calls[0][2] as SendOptions).toolExecutionTimeoutMs).toBe(30_000)
  })

  it("forwards the onEvent live-output sink into the capture options", async () => {
    const capture = jest.fn().mockResolvedValue(captureResult())
    const onEvent = jest.fn()
    await runCliSubagent(def(), "go", "p", {
      config: cfg(),
      home: "/h",
      cwd: "/work",
      gate: createPermissionGate({ yes: true }),
      mcpServers: [],
      approvedTools: new Set<string>(),
      disabledMcpTools: new Set<string>(),
      resolveOptions: async () => ({ provider: "opencode-go" }) as unknown as SendOptions,
      capture,
      closeSession: jest.fn().mockResolvedValue(undefined),
      mintId: () => "x",
      onEvent,
    })
    expect((capture.mock.calls[0][3] as { onEvent?: unknown }).onEvent).toBe(onEvent)
  })

  it("omits onEvent from the capture options when no sink is provided", async () => {
    const capture = jest.fn().mockResolvedValue(captureResult())
    await runCliSubagent(def(), "go", "p", {
      config: cfg(),
      home: "/h",
      cwd: "/work",
      gate: createPermissionGate({ yes: true }),
      mcpServers: [],
      approvedTools: new Set<string>(),
      disabledMcpTools: new Set<string>(),
      resolveOptions: async () => ({ provider: "opencode-go" }) as unknown as SendOptions,
      capture,
      closeSession: jest.fn().mockResolvedValue(undefined),
      mintId: () => "x",
    })
    expect((capture.mock.calls[0][3] as { onEvent?: unknown }).onEvent).toBeUndefined()
  })

  it("retires the child session even when the turn throws", async () => {
    const closeSession = jest.fn().mockResolvedValue(undefined)
    const capture = jest.fn().mockRejectedValue(new Error("boom"))
    await expect(
      runCliSubagent(def(), "go", "p", {
        config: cfg(),
        home: "/h",
        cwd: "/work",
        gate: createPermissionGate({ yes: true }),
        mcpServers: [],
        approvedTools: new Set<string>(),
        disabledMcpTools: new Set<string>(),
        resolveOptions: async () => ({ provider: "opencode-go" }) as unknown as SendOptions,
        capture,
        closeSession,
        mintId: () => "z",
      })
    ).rejects.toThrow("boom")
    expect(closeSession).toHaveBeenCalledWith("p::sub-z")
  })

  it("falls back to the live sidecar collaborators (and defaultMintId) when deps are not injected", async () => {
    const ipc = jest.requireMock("@/lib/claude/ipc") as { closeSession: jest.Mock }
    const cap = jest.requireMock("@/lib/claude/run-and-capture") as {
      runAndCaptureAssistantReply: jest.Mock
    }
    cap.runAndCaptureAssistantReply.mockClear()
    ipc.closeSession.mockClear()

    const r = await runCliSubagent(def(), "go", "parent", {
      config: cfg(),
      home: "/h",
      cwd: "/work",
      gate: createPermissionGate({ yes: true }),
      mcpServers: [],
      approvedTools: new Set<string>(),
      disabledMcpTools: new Set<string>(),
    })

    expect(cap.runAndCaptureAssistantReply).toHaveBeenCalledTimes(1)
    // defaultMintId yields an 8-char hex suffix under the parent session id.
    const childId = cap.runAndCaptureAssistantReply.mock.calls[0][0] as string
    expect(childId).toMatch(/^parent::sub-[0-9a-f]{8}$/)
    expect(ipc.closeSession).toHaveBeenCalledWith(childId)
    expect(r.text).toBe("from default capture")
  })

  it("runs the subagent on a DIFFERENT configured provider (cross-provider) with its model", async () => {
    let ctxSeen: BuildOptionsContext | null = null
    await runCliSubagent(def({ provider: "anthropic", model: "sonnet" }), "go", "p", {
      config: cfg({
        providers: { "opencode-go": { apiKey: "k" }, anthropic: { authToken: "t" } },
      }),
      home: "/h",
      cwd: "/work",
      gate: createPermissionGate({ yes: true }),
      mcpServers: [],
      approvedTools: new Set<string>(),
      disabledMcpTools: new Set<string>(),
      resolveOptions: async (ctx) => {
        ctxSeen = ctx
        return { provider: "anthropic" } as unknown as SendOptions
      },
      capture: async () => captureResult(),
      closeSession: async () => undefined,
      mintId: () => "x",
    })
    // The child session re-routes to the subagent's provider + model.
    expect(ctxSeen!.session?.providerOverride).toBe("anthropic")
    expect(ctxSeen!.session?.model).toBe("sonnet")
  })

  it("falls back to the parent provider and drops the model when the provider is not configured", async () => {
    let ctxSeen: BuildOptionsContext | null = null
    await runCliSubagent(def({ provider: "anthropic", model: "sonnet" }), "go", "p", {
      config: cfg(), // only opencode-go configured
      home: "/h",
      cwd: "/work",
      gate: createPermissionGate({ yes: true }),
      mcpServers: [],
      approvedTools: new Set<string>(),
      disabledMcpTools: new Set<string>(),
      resolveOptions: async (ctx) => {
        ctxSeen = ctx
        return { provider: "opencode-go" } as unknown as SendOptions
      },
      capture: async () => captureResult(),
      closeSession: async () => undefined,
      mintId: () => "x",
    })
    // Unconfigured provider → stay on the parent; the cross-provider model is NOT
    // forced onto it (it would name a model the parent can't serve).
    expect(ctxSeen!.session?.providerOverride).toBe("opencode-go")
    expect(ctxSeen!.session?.model).not.toBe("sonnet")
  })

  it("swaps only the model within the parent provider when no provider is given", async () => {
    let ctxSeen: BuildOptionsContext | null = null
    await runCliSubagent(def({ model: "sub-model" }), "go", "p", {
      config: cfg(),
      home: "/h",
      cwd: "/work",
      gate: createPermissionGate({ yes: true }),
      mcpServers: [],
      approvedTools: new Set<string>(),
      disabledMcpTools: new Set<string>(),
      resolveOptions: async (ctx) => {
        ctxSeen = ctx
        return { provider: "opencode-go" } as unknown as SendOptions
      },
      capture: async () => captureResult(),
      closeSession: async () => undefined,
      mintId: () => "x",
    })
    expect(ctxSeen!.session?.providerOverride).toBe("opencode-go")
    expect(ctxSeen!.session?.model).toBe("sub-model")
  })

  it("omits usage / finishReason when the capture result carries neither", async () => {
    const r = await runCliSubagent(def(), "go", "p", {
      config: cfg(),
      home: "/h",
      cwd: "/work",
      gate: createPermissionGate({ yes: true }),
      mcpServers: [],
      approvedTools: new Set<string>(),
      disabledMcpTools: new Set<string>(),
      resolveOptions: async () => ({ provider: "opencode-go" }) as unknown as SendOptions,
      capture: async () => captureResult({ text: "bare" }),
      closeSession: async () => undefined,
      mintId: () => "y",
    })
    expect(r).toEqual({ text: "bare" })
  })
})

describe("runCliSubagent, definition fidelity", () => {
  function setupDeps(): RunCliSubagentDeps {
    return {
      config: cfg(),
      home: "/unused",
      cwd: "/work",
      gate: createPermissionGate({ yes: true }),
      mcpServers: [],
      approvedTools: new Set(),
      disabledMcpTools: new Set(),
      resolveOptions: jest.fn(async () => ({})),
      resolveHooks: () => undefined,
      capture: jest.fn(async () => captureResult()),
      closeSession: jest.fn(async () => undefined),
      mintId: () => "fidelity",
    }
  }

  it("unions the definition's disallowedTools into the child's send options", async () => {
    const deps = setupDeps()
    deps.capture = jest.fn(async () => captureResult())
    await runCliSubagent(def({ disallowedTools: ["bash", "write"] }), "go", "parent", deps)
    const sendOptions = (deps.capture as jest.Mock).mock.calls[0][2] as SendOptions
    expect(sendOptions.disallowedTools).toEqual(expect.arrayContaining(["bash", "write"]))
  })

  it("unions the user config's disabledTools into the child's send options", async () => {
    const deps = setupDeps()
    deps.config = cfg({ disabledTools: ["mcp__github__push", "bash"] })
    deps.disabledMcpTools = new Set(["mcp__s__x"])
    deps.capture = jest.fn(async () => captureResult())
    await runCliSubagent(def({ disallowedTools: ["bash"] }), "go", "parent", deps)
    const sendOptions = (deps.capture as jest.Mock).mock.calls[0][2] as SendOptions
    expect(sendOptions.disallowedTools).toEqual(
      expect.arrayContaining(["bash", "mcp__github__push", "mcp__s__x"])
    )
  })

  it("forwards the definition's effort dial", async () => {
    const deps = setupDeps()
    deps.capture = jest.fn(async () => captureResult())
    await runCliSubagent(def({ effort: "high" }), "go", "parent", deps)
    const sendOptions = (deps.capture as jest.Mock).mock.calls[0][2] as SendOptions
    expect(sendOptions.effort).toBe("high")
    await runCliSubagent(def(), "go", "parent", deps)
    const plain = (deps.capture as jest.Mock).mock.calls[1][2] as SendOptions
    expect(plain.effort).toBeUndefined()
  })

  it("tells a leaf it cannot delegate and a nesting child that it may", async () => {
    const seen: string[] = []
    const deps = setupDeps()
    deps.resolveOptions = async (ctx) => {
      seen.push(ctx.session?.systemPrompt ?? "")
      return { provider: "opencode-go" } as unknown as SendOptions
    }
    deps.capture = jest.fn(async () => captureResult())
    await runCliSubagent(def(), "go", "parent", deps)
    expect(seen[0]).toContain("cannot dispatch subagents of your own")
    deps.nesting = {
      manifest: { name: "dispatch_agent" } as never,
      register: () => {},
      unregister: () => {},
    }
    await runCliSubagent(def(), "go", "parent", deps)
    expect(seen[1]).toContain("`dispatch_agent`")
  })
})

describe("runCliSubagent Prompt Center overrides (ADR-0236)", () => {
  it("resolves the child's prompt slots against the workspace mounting its cwd", async () => {
    let seen: BuildOptionsContext | undefined
    const prime = jest.fn(async () => ({ workspaceId: "ws-9" }))
    await runCliSubagent(def(), "task", "parent", {
      config: cfg(),
      home: "/h",
      cwd: "/work",
      gate: createPermissionGate({ yes: true }),
      mcpServers: [],
      approvedTools: new Set(),
      disabledMcpTools: new Set(),
      primePromptOverrides: prime,
      resolveOptions: async (ctx) => {
        seen = ctx
        return {} as SendOptions
      },
      resolveHooks: () => undefined,
      capture: jest.fn(async () => ({
        text: "ok",
        messageId: "m",
        a2uiSurfaces: {},
        a2uiSurfaceOrder: [],
      })) as unknown as RunCliSubagentDeps["capture"],
      closeSession: jest.fn(async () => undefined),
      mintId: () => "p",
    })
    expect(prime).toHaveBeenCalledWith("/work")
    expect(seen?.promptWorkspaceId).toBe("ws-9")
  })
})

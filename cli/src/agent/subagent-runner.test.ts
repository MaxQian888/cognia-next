/**
 * @jest-environment node
 */
import { runCliSubagent } from "./subagent-runner"
import type { BuildOptionsContext } from "@/lib/claude/build-options"
import type { SendOptions } from "@/lib/claude/types"
import type { RunAndCaptureResult } from "@/lib/claude/run-and-capture"
import type { PluginSubagentDef } from "@/types/plugin/plugin-subagent"
import { DEFAULT_RESOLVED_CONFIG, type ResolvedConfig } from "../config/schema"
import { DEFAULT_BUILTIN_TOOLS } from "@/lib/claude/types"
import { createPermissionGate } from "./permission-gate"

// Mock the live-sidecar default collaborators so the "no injected deps" path —
// where runCliSubagent falls back to them — is exercisable without a sidecar.
// Tests that inject their own deps bypass these entirely (injection wins).
jest.mock("@/lib/claude/build-options", () => ({
  resolveSendOptions: jest.fn(async () => ({ provider: "opencode-go" })),
}))
jest.mock("@/lib/claude/run-and-capture", () => ({
  runAndCaptureAssistantReply: jest.fn(async () => ({
    text: "from default capture",
    messageId: "m",
    a2uiSurfaces: {},
    a2uiSurfaceOrder: [],
  })),
}))
jest.mock("@/lib/claude/ipc", () => ({ closeSession: jest.fn(async () => undefined) }))

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
    expect(ctxSeen!.session?.systemPrompt).toBe("You are a reviewer.")
    expect(ctxSeen!.session?.model).toBe("sub-model")
    expect(ctxSeen!.character?.allowedTools).toEqual(["Read"])

    // Auto-approve + disabled overlay applied to the child's send options.
    expect((sendOptions as SendOptions).suppressApprovalForTools).toContain(
      "mcp__cognia-tools__bash"
    )
    expect((sendOptions as SendOptions).disallowedTools).toContain("mcp__s__x")

    // The parent turn's gate answers the subagent's tool approvals.
    expect((capOpts as { onPermissionRequest: unknown }).onPermissionRequest).toBe(gate)

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

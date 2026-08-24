/**
 * Tests for the PII-aware safeSendPrompt wrapper.
 *
 * We mock both `runAndCaptureAssistantReply` and `appendAudit` so the
 * tests stay in-process (no Dexie writes, no event subscription).
 */

import {
  GroundingGateBlocked,
  PiiGateBlocked,
  _resetSystemPromptPiiCacheForTest,
  hasNoLeakingPiiCached,
  isPiiSafeSendContent,
  safeSendPrompt,
} from "./safe-send-prompt"

jest.mock("@/lib/claude/run-and-capture", () => {
  return {
    __esModule: true,
    RunAndCaptureError: class RunAndCaptureError extends Error {},
    runAndCaptureAssistantReply: jest.fn(async () => ({
      text: "model reply",
      messageId: "msg-1",
    })),
  }
})

jest.mock("@/lib/connectors/audit", () => {
  return {
    __esModule: true,
    appendAudit: jest.fn(async () => undefined),
  }
})

jest.mock("@/lib/db/session-usage", () => {
  return {
    __esModule: true,
    recordConnectorUsage: jest.fn(async () => ({ messageId: "conn-row" })),
    swallowUsageWrite: jest.fn(),
  }
})

jest.mock("@/lib/claude/provider-telemetry", () => {
  return {
    __esModule: true,
    recordProviderOutcome: jest.fn(),
  }
})

jest.mock("@/lib/task-workspace/client", () => ({
  __esModule: true,
  acquireWorkspaceBundle: jest.fn(),
}))

jest.mock("@/lib/task-workspace/run-lease", () => ({
  __esModule: true,
  openWorkspaceBundleTurnLease: jest.fn(),
}))

import { runAndCaptureAssistantReply } from "@/lib/claude/run-and-capture"
import { appendAudit } from "@/lib/connectors/audit"
import { recordProviderOutcome } from "@/lib/claude/provider-telemetry"
import { recordConnectorUsage, swallowUsageWrite } from "@/lib/db/session-usage"
import { acquireWorkspaceBundle } from "@/lib/task-workspace/client"
import { openWorkspaceBundleTurnLease } from "@/lib/task-workspace/run-lease"

const mockRun = runAndCaptureAssistantReply as jest.MockedFunction<
  typeof runAndCaptureAssistantReply
>
const mockAudit = appendAudit as jest.MockedFunction<typeof appendAudit>
const mockRecordConnectorUsage = recordConnectorUsage as jest.MockedFunction<
  typeof recordConnectorUsage
>
const mockSwallowUsageWrite = swallowUsageWrite as jest.MockedFunction<typeof swallowUsageWrite>
const mockRecordProviderOutcome = recordProviderOutcome as jest.MockedFunction<
  typeof recordProviderOutcome
>
const mockAcquireWorkspaceBundle = acquireWorkspaceBundle as jest.MockedFunction<
  typeof acquireWorkspaceBundle
>
const mockOpenWorkspaceBundleTurnLease = openWorkspaceBundleTurnLease as jest.MockedFunction<
  typeof openWorkspaceBundleTurnLease
>

beforeEach(() => {
  mockRun.mockClear()
  mockAudit.mockClear()
  mockRecordConnectorUsage.mockClear()
  mockSwallowUsageWrite.mockClear()
  mockRecordProviderOutcome.mockClear()
  mockAcquireWorkspaceBundle.mockReset()
  mockOpenWorkspaceBundleTurnLease.mockReset()
})

describe("isPiiSafeSendContent", () => {
  it("accepts a clean string prompt", () => {
    expect(isPiiSafeSendContent("hello there")).toBe(true)
  })

  it("rejects a string prompt containing an email", () => {
    expect(isPiiSafeSendContent("ping me at user@example.com")).toBe(false)
  })

  it("walks SendContentBlock[] arrays — accepts a clean block list", () => {
    expect(isPiiSafeSendContent([{ type: "text", text: "all good" }] as never)).toBe(true)
  })

  it("walks SendContentBlock[] arrays — rejects on any tainted text block", () => {
    expect(
      isPiiSafeSendContent([
        { type: "text", text: "fine" },
        { type: "text", text: "leak: user@example.com" },
      ] as never)
    ).toBe(false)
  })

  it("ignores non-text blocks (image / file) on the gate path", () => {
    expect(
      isPiiSafeSendContent([
        { type: "text", text: "ok" },
        {
          type: "image",
          source: { type: "base64", media_type: "image/png", data: "Zm9v" },
        } as never,
      ] as never)
    ).toBe(true)
  })

  it("treats unrecognised content shapes as safe by default", () => {
    expect(isPiiSafeSendContent(null as unknown as string)).toBe(true)
  })
})

describe("safeSendPrompt", () => {
  const auditCtx = { adapterId: "adp_1", conversationKey: "telegram:adp_1:c1" }

  it("delegates to runAndCaptureAssistantReply when prompt is clean", async () => {
    const result = await safeSendPrompt("sess_1", "hello", undefined, auditCtx)
    expect(result).toEqual({ text: "model reply", messageId: "msg-1" })
    expect(mockRun).toHaveBeenCalledWith(
      "sess_1",
      "hello",
      undefined,
      expect.objectContaining({ execution: expect.objectContaining({ kind: "connector" }) })
    )
    expect(mockAudit).not.toHaveBeenCalled()
  })

  it("aborts before sendPrompt when prompt carries PII and audits with reason=pii_blocked", async () => {
    await expect(
      safeSendPrompt("sess_1", "email me at user@example.com", undefined, auditCtx)
    ).rejects.toBeInstanceOf(PiiGateBlocked)
    expect(mockRun).not.toHaveBeenCalled()
    expect(mockAudit).toHaveBeenCalledTimes(1)
    expect(mockAudit.mock.calls[0][0]).toMatchObject({
      adapterId: "adp_1",
      conversationKey: "telegram:adp_1:c1",
      kind: "adapter.error",
      reason: "pii_blocked",
    })
  })

  it("aborts when options.appendSystemPrompt leaks PII", async () => {
    await expect(
      safeSendPrompt(
        "sess_1",
        "clean prompt",
        // Build-options injected a capability prompt that accidentally
        // embedded a user contact — should still abort.
        { appendSystemPrompt: "respond as user@example.com would" },
        auditCtx
      )
    ).rejects.toBeInstanceOf(PiiGateBlocked)
    expect(mockRun).not.toHaveBeenCalled()
    expect(mockAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: "pii_blocked",
        message: expect.stringContaining("appendSystemPrompt"),
      })
    )
  })

  it("propagates RunAndCaptureError from the underlying call", async () => {
    const err = new Error("kaboom")
    mockRun.mockRejectedValueOnce(err)
    await expect(safeSendPrompt("sess_1", "clean", undefined, auditCtx)).rejects.toThrow("kaboom")
    // No PII gate audit: the failure happened past the gate.
    expect(mockAudit).not.toHaveBeenCalled()
  })

  it("blocks a retrieval-backed outbound reply with unsupported claims", async () => {
    mockRun.mockResolvedValueOnce({
      text: "The workspace uses pnpm. Revenue doubled yesterday.",
      messageId: "msg-grounding",
      a2uiSurfaces: {},
      a2uiSurfaceOrder: [],
    })

    await expect(
      safeSendPrompt(
        "sess_1",
        "clean",
        {
          projectKnowledgeContext: {
            retrievedChunks: [{ fileId: "package", content: "The workspace uses pnpm.", score: 1 }],
            degraded: false,
          },
        },
        auditCtx
      )
    ).rejects.toBeInstanceOf(GroundingGateBlocked)
    expect(mockAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: "grounding_below_threshold",
        fields: { supportedClaims: 1, unsupportedClaims: 1 },
      })
    )
  })

  it("passes signal + timeoutMs through to the underlying call", async () => {
    const ac = new AbortController()
    await safeSendPrompt("sess_1", "clean", undefined, {
      ...auditCtx,
      signal: ac.signal,
      timeoutMs: 10_000,
    })
    expect(mockRun).toHaveBeenCalledWith(
      "sess_1",
      "clean",
      undefined,
      expect.objectContaining({ signal: ac.signal, timeoutMs: 10_000 })
    )
  })

  it("forwards onPermissionRequest + onEvent so IM HITL and live-activity survive the gate", async () => {
    const onPermissionRequest = jest.fn()
    const onEvent = jest.fn()
    await safeSendPrompt("sess_1", "clean", undefined, {
      ...auditCtx,
      onPermissionRequest,
      onEvent,
    })
    expect(mockRun).toHaveBeenCalledWith(
      "sess_1",
      "clean",
      undefined,
      expect.objectContaining({ onPermissionRequest, onEvent })
    )
  })

  it("records connector usage and provider telemetry when the captured result includes usage", async () => {
    const usage = {
      inputTokens: 100,
      outputTokens: 25,
      cacheReadInputTokens: 7,
      cacheCreationInputTokens: 3,
      totalCostUsd: 0.012,
      durationMs: 750,
    }
    mockRun.mockResolvedValueOnce({
      text: "model reply",
      messageId: "msg-usage",
      a2uiSurfaces: {},
      a2uiSurfaceOrder: [],
      usage,
    })

    const result = await safeSendPrompt(
      "sess_1",
      "clean",
      { provider: "openai", model: "gpt-4o" },
      auditCtx
    )

    expect(result.usage).toBe(usage)
    expect(mockRecordConnectorUsage).toHaveBeenCalledWith({
      adapterId: "adp_1",
      conversationKey: "telegram:adp_1:c1",
      usage,
    })
    expect(mockSwallowUsageWrite).toHaveBeenCalledWith(expect.any(Promise))
    expect(mockRecordProviderOutcome).toHaveBeenCalledWith({
      providerId: "openai",
      ok: true,
      latencyMs: 750,
      estimatedCostUsd: 0.012,
      modelId: "gpt-4o",
      tokensUsed: 125,
      inputTokens: 100,
      outputTokens: 25,
      cacheReadTokens: 7,
      cacheCreationTokens: 3,
      sessionId: "sess_1",
      surface: "connector",
    })
  })

  it("threads the connector turn's traceId/spanId into the provider outcome", async () => {
    const usage = {
      inputTokens: 10,
      outputTokens: 5,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      totalCostUsd: 0.001,
      durationMs: 120,
    }
    mockRun.mockResolvedValueOnce({
      text: "reply",
      messageId: "msg-trace",
      a2uiSurfaces: {},
      a2uiSurfaceOrder: [],
      usage,
    })

    await safeSendPrompt(
      "sess_1",
      "clean",
      { provider: "openai", model: "gpt-4o", traceId: "a".repeat(32), spanId: "b".repeat(16) },
      auditCtx
    )

    expect(mockRecordProviderOutcome).toHaveBeenCalledWith(
      expect.objectContaining({
        traceId: "a".repeat(32),
        parentSpanId: "b".repeat(16),
        surface: "connector",
      })
    )
  })

  it("does not write usage telemetry when the captured result has no usage", async () => {
    await safeSendPrompt("sess_1", "clean", undefined, auditCtx)

    expect(mockRecordConnectorUsage).not.toHaveBeenCalled()
    expect(mockSwallowUsageWrite).not.toHaveBeenCalled()
    expect(mockRecordProviderOutcome).not.toHaveBeenCalled()
  })

  it("records connector usage without provider outcome when provider is unresolved", async () => {
    const usage = {
      inputTokens: 10,
      outputTokens: 5,
      totalCostUsd: 0.002,
      durationMs: 100,
    }
    mockRun.mockResolvedValueOnce({
      text: "model reply",
      messageId: "msg-usage",
      a2uiSurfaces: {},
      a2uiSurfaceOrder: [],
      usage,
    })

    await safeSendPrompt("sess_1", "clean", undefined, auditCtx)

    expect(mockRecordConnectorUsage).toHaveBeenCalledWith({
      adapterId: "adp_1",
      conversationKey: "telegram:adp_1:c1",
      usage,
    })
    expect(mockRecordProviderOutcome).not.toHaveBeenCalled()
  })

  it("routes every unique writable root through one managed Bundle Turn", async () => {
    const settle = jest.fn(async () => [])
    const abort = jest.fn(async () => [])
    const bundle = {
      bundleId: "bundle-connector",
      environmentKind: "managed" as const,
      ownerType: "session" as const,
      ownerRef: "sess_1",
      state: "active" as const,
      leases: [],
      lastUsedAt: 1,
      pinned: false,
      createdAt: 1,
    }
    mockAcquireWorkspaceBundle.mockResolvedValueOnce(bundle)
    mockOpenWorkspaceBundleTurnLease.mockResolvedValueOnce({
      bundleTurnId: "bundle-turn-1",
      bundleId: bundle.bundleId,
      run: { runId: "connector-run-1" } as never,
      runs: [],
      primaryAlias: "/managed/repo",
      additionalAliases: ["/managed/repo/packages/deep", "/managed/repo/docs"],
      settle,
      abort,
    })

    await safeSendPrompt(
      "sess_1",
      "clean",
      {
        cwd: "/repo",
        additionalDirectories: [
          "/repo/docs",
          "/repo/packages/deep",
          "/repo/docs",
          " /repo/packages/deep ",
          "/repo",
        ],
        confinement: {
          enabled: true,
          roots: ["/repo", "/repo/docs", "/read-only/reference"],
        },
        trustedWorkspaceRoots: ["/repo", "/repo/packages/deep"],
        turnId: "turn-1",
      },
      auditCtx
    )

    expect(mockAcquireWorkspaceBundle).toHaveBeenCalledWith({
      ownerType: "session",
      ownerRef: "sess_1",
      environmentKind: "managed",
      base: { kind: "remoteDefault" },
      roots: [
        { logicalRootId: "connector-root-0", role: "primary", sourceRoot: "/repo" },
        {
          logicalRootId: "connector-root-1",
          role: "additional",
          sourceRoot: "/repo/packages/deep",
        },
        {
          logicalRootId: "connector-root-2",
          role: "additional",
          sourceRoot: "/repo/docs",
        },
      ],
    })
    expect(mockOpenWorkspaceBundleTurnLease).toHaveBeenCalledWith(
      bundle,
      "connector-root-0",
      expect.objectContaining({
        sessionId: "sess_1",
        turnId: "turn-1",
        surface: "connector",
        agentId: "adp_1",
        agentKind: "connector",
        workspaceRoot: "/repo",
      })
    )
    expect(mockRun).toHaveBeenCalledWith(
      "sess_1",
      "clean",
      expect.objectContaining({
        cwd: "/managed/repo",
        additionalDirectories: ["/managed/repo/packages/deep", "/managed/repo/docs"],
        confinement: {
          enabled: true,
          roots: ["/managed/repo", "/managed/repo/docs", "/read-only/reference"],
        },
        trustedWorkspaceRoots: ["/managed/repo", "/managed/repo/packages/deep"],
        taskWorkspace: expect.objectContaining({
          runId: "connector-run-1",
          workspaceRoot: "/repo",
        }),
      }),
      expect.any(Object)
    )
    expect(settle).toHaveBeenCalledWith("ready")
    expect(abort).not.toHaveBeenCalled()
  })

  it("fails closed when Registry Bundle acquisition fails", async () => {
    mockAcquireWorkspaceBundle.mockRejectedValueOnce(new Error("registry unavailable"))

    await expect(safeSendPrompt("sess_1", "clean", { cwd: "/repo" }, auditCtx)).rejects.toThrow(
      "registry unavailable"
    )

    expect(mockOpenWorkspaceBundleTurnLease).not.toHaveBeenCalled()
    expect(mockRun).not.toHaveBeenCalled()
  })

  it("stands down — without failing the turn — when a sandbox runtime is already bound", async () => {
    // `resolveSendOptions` stamps `sandboxRuntimeRef` for EVERY session with the
    // sandbox or Computer Use enabled, so refusing here failed every inbound
    // auto-reply for those users. The bundle declines to remap on top of an
    // authoritative placement; the send proceeds under that placement.
    await expect(
      safeSendPrompt(
        "sess_1",
        "clean",
        { cwd: "/repo", sandboxRuntimeRef: "sandbox-live-root" },
        auditCtx
      )
    ).resolves.toMatchObject({ text: "model reply" })

    expect(mockAcquireWorkspaceBundle).not.toHaveBeenCalled()
    expect(mockOpenWorkspaceBundleTurnLease).not.toHaveBeenCalled()
    // The turn ran, and it ran with the original options — no alias remap.
    expect(mockRun).toHaveBeenCalledTimes(1)
    expect(mockRun.mock.calls[0][2]).toMatchObject({
      cwd: "/repo",
      sandboxRuntimeRef: "sandbox-live-root",
    })
  })

  it("fails closed when Registry does not open a Bundle Turn", async () => {
    mockAcquireWorkspaceBundle.mockResolvedValueOnce({
      bundleId: "bundle-connector",
      environmentKind: "managed",
      ownerType: "session",
      ownerRef: "sess_1",
      state: "active",
      leases: [],
      lastUsedAt: 1,
      pinned: false,
      createdAt: 1,
    })
    mockOpenWorkspaceBundleTurnLease.mockResolvedValueOnce(null)

    await expect(safeSendPrompt("sess_1", "clean", { cwd: "/repo" }, auditCtx)).rejects.toThrow(
      "Connector workspace Bundle Turn is unavailable"
    )

    expect(mockRun).not.toHaveBeenCalled()
  })

  it("aborts the whole Bundle Turn when isolated execution fails", async () => {
    const settle = jest.fn(async () => [])
    const abort = jest.fn(async () => [])
    mockAcquireWorkspaceBundle.mockResolvedValueOnce({
      bundleId: "bundle-connector",
      environmentKind: "managed",
      ownerType: "session",
      ownerRef: "sess_1",
      state: "active",
      leases: [],
      lastUsedAt: 1,
      pinned: false,
      createdAt: 1,
    })
    mockOpenWorkspaceBundleTurnLease.mockResolvedValueOnce({
      bundleTurnId: "bundle-turn-1",
      bundleId: "bundle-connector",
      run: { runId: "connector-run-1" } as never,
      runs: [],
      primaryAlias: "/managed/repo",
      additionalAliases: [],
      settle,
      abort,
    })
    mockRun.mockRejectedValueOnce(new Error("model failed"))

    await expect(safeSendPrompt("sess_1", "clean", { cwd: "/repo" }, auditCtx)).rejects.toThrow(
      "model failed"
    )

    expect(abort).toHaveBeenCalledTimes(1)
    expect(settle).not.toHaveBeenCalled()
    expect(mockRun).toHaveBeenCalledWith(
      "sess_1",
      "clean",
      expect.objectContaining({ cwd: "/managed/repo" }),
      expect.any(Object)
    )
  })
})

describe("hasNoLeakingPiiCached", () => {
  beforeEach(() => _resetSystemPromptPiiCacheForTest())

  it("returns true for clean text and false for leaking text", () => {
    expect(hasNoLeakingPiiCached("just a friendly hello")).toBe(true)
    expect(hasNoLeakingPiiCached("email me at alice@example.com")).toBe(false)
  })

  it("returns the cached result on a repeat call (LRU recency-refresh path)", () => {
    const text = "a stable system prompt with no pii in it"
    expect(hasNoLeakingPiiCached(text)).toBe(true)
    // Second call hits the cache (delete + re-set refreshes recency).
    expect(hasNoLeakingPiiCached(text)).toBe(true)
  })

  it("evicts the oldest entry once the cap is exceeded and stays correct", () => {
    for (let i = 0; i < 70; i++) {
      expect(hasNoLeakingPiiCached(`clean system prompt number ${i}`)).toBe(true)
    }
    expect(hasNoLeakingPiiCached("clean system prompt number 69")).toBe(true)
    // A never-seen leaking prompt is a cache miss and still fails the gate.
    expect(hasNoLeakingPiiCached("reach me at bob@example.org any time")).toBe(false)
  })
})

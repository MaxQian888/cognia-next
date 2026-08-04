/**
 * Tests for the plugin agent executor.
 *
 * Covers both execution channels:
 *  - text-only (`streamText`) — the web/mobile fallback and the default when
 *    `toolsEnabled` is not requested;
 *  - tool-enabled (`runAndCaptureAssistantReply` via the sidecar) — gated on
 *    `toolsEnabled` + a reachable desktop sidecar.
 */

import { streamText } from "ai"
import { resolveFeatureProvider, createFeatureProviderModel } from "@/lib/ai/provider-consumption"
import { isTauri } from "@/lib/tauri"
import { resolveCharacterById } from "@/lib/db/characters"
import { createSession, getSession, deleteSession, setSdkSessionId } from "@/lib/db/sessions"
import { getSettings } from "@/lib/db/settings"
import { resolveSendOptions } from "@/lib/claude/build-options"
import { runAndCaptureAssistantReply } from "@/lib/claude/run-and-capture"
import { buildRoutingEngine } from "@cognia/provider-routing/build-preview-engine"
import { executeAgent } from "./agent-executor"

const mockPlanRoute = jest.fn()
const mockApplyCircuitBreakerSettings = jest.fn()
const mockLiveSettingsState: { settings?: Record<string, unknown> } = {}
const mockResolveProviderAttemptOptions = jest.fn()
const mockHasNoLeakingPiiDeep = jest.fn((_value?: unknown) => true)

jest.mock("ai", () => ({ streamText: jest.fn() }))
jest.mock("@/lib/ai/provider-consumption", () => ({
  createProviderSettingsSnapshot: jest.fn((input) => input),
  resolveFeatureProvider: jest.fn(),
  createFeatureProviderModel: jest.fn(),
}))
jest.mock("@/lib/tauri", () => ({ isTauri: jest.fn(() => false) }))
jest.mock("@/lib/db/characters", () => ({ resolveCharacterById: jest.fn() }))
jest.mock("@/lib/db/sessions", () => ({
  createSession: jest.fn(),
  getSession: jest.fn(),
  deleteSession: jest.fn(),
  setSdkSessionId: jest.fn(),
}))
jest.mock("@/lib/db/settings", () => ({ getSettings: jest.fn() }))
jest.mock("@/lib/claude/build-options", () => ({ resolveSendOptions: jest.fn() }))
jest.mock("@/lib/claude/run-and-capture", () => ({ runAndCaptureAssistantReply: jest.fn() }))
jest.mock("@cognia/provider-routing/build-preview-engine", () => ({
  applyCircuitBreakerSettings: (...args: unknown[]) => mockApplyCircuitBreakerSettings(...args),
  buildRoutingEngine: jest.fn(() => ({ planRoute: mockPlanRoute })),
}))
jest.mock("@/stores/settings", () => ({
  useSettingsStore: { getState: () => mockLiveSettingsState },
}))
jest.mock("@/lib/claude/provider-attempt-options", () => ({
  resolveProviderAttemptOptions: (...args: unknown[]) => mockResolveProviderAttemptOptions(...args),
}))
jest.mock("@cognia/redact", () => ({
  hasNoLeakingPiiDeep: (value: unknown) => mockHasNoLeakingPiiDeep(value),
}))

const mockStreamText = streamText as jest.MockedFunction<typeof streamText>
const mockResolveProvider = resolveFeatureProvider as jest.MockedFunction<
  typeof resolveFeatureProvider
>
const mockCreateModel = createFeatureProviderModel as jest.MockedFunction<
  typeof createFeatureProviderModel
>
const mockIsTauri = isTauri as jest.MockedFunction<typeof isTauri>
const mockResolveCharacter = resolveCharacterById as jest.MockedFunction<
  typeof resolveCharacterById
>
const mockCreateSession = createSession as jest.MockedFunction<typeof createSession>
const mockGetSession = getSession as jest.MockedFunction<typeof getSession>
const mockDeleteSession = deleteSession as jest.MockedFunction<typeof deleteSession>
const mockSetSdkSessionId = setSdkSessionId as jest.MockedFunction<typeof setSdkSessionId>
const mockGetSettings = getSettings as jest.MockedFunction<typeof getSettings>
const mockResolveSendOptions = resolveSendOptions as jest.MockedFunction<typeof resolveSendOptions>
const mockRunAndCapture = runAndCaptureAssistantReply as jest.MockedFunction<
  typeof runAndCaptureAssistantReply
>
const mockBuildRoutingEngine = buildRoutingEngine as jest.MockedFunction<typeof buildRoutingEngine>

function routingPlan(
  candidates: Array<{ providerId: string; modelId: string }> = [
    { providerId: "openai", modelId: "gpt-4o" },
  ]
) {
  const orderedCandidates = candidates.map((candidate, index) => ({
    ...candidate,
    deploymentId: `${candidate.providerId}::${candidate.modelId}`,
    reasonCodes: index === 0 ? ["manual-override"] : ["fallback-transient"],
  }))
  return {
    decisionId: "route-agent-1",
    surface: "agent",
    requested: { kind: "manual", providerId: "openai", modelId: "gpt-4o" },
    strategy: "reliability",
    selected: orderedCandidates[0],
    orderedCandidates,
    reasonCodes: ["manual-override"],
    rejected: [],
    replayPolicy: "pre-commit-only",
    createdAt: 1,
  }
}

function primeTextChannel(parts: string[] = ["hello"], finishReason = "stop") {
  mockResolveProvider.mockReturnValue({
    kind: "resolved",
    featureId: "plugin-agent-executor",
    routeProfile: "general-text",
    providerId: "openai",
    model: "gpt-4o",
    apiKey: "sk-x",
    baseURL: "https://api.openai.com/v1",
    protocol: "openai",
    isCustomProvider: false,
    executionMode: "direct-model",
    useProxy: false,
    attemptedProviderIds: ["openai"],
    fallbackProviderIds: [],
  } as never)
  mockCreateModel.mockReturnValue({ id: "model" } as never)
  mockStreamText.mockReturnValue({
    textStream: (async function* () {
      for (const p of parts) yield p
    })(),
    finishReason: Promise.resolve(finishReason),
  } as never)
}

describe("executeAgent", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockLiveSettingsState.settings = undefined
    mockIsTauri.mockReturnValue(false)
    mockPlanRoute.mockResolvedValue(routingPlan())
    mockHasNoLeakingPiiDeep.mockReturnValue(true)
    mockResolveProviderAttemptOptions.mockResolvedValue({
      providerCredentials: { apiKey: "sk-fallback", protocol: "anthropic" },
    })
  })

  describe("text-only channel", () => {
    it("streams text and reports channel='text', toolsAvailable=false", async () => {
      primeTextChannel(["foo", "bar"])
      const result = await executeAgent("hi")
      expect(result.text).toBe("foobar")
      expect(result.channel).toBe("text")
      expect(result.toolsAvailable).toBe(false)
      expect(result.finishReason).toBe("stop")
      expect(mockRunAndCapture).not.toHaveBeenCalled()
      expect(mockPlanRoute).toHaveBeenCalledWith(
        expect.objectContaining({
          surface: "agent",
          promptText: "hi",
          selection: { kind: "manual", providerId: "openai", modelId: "gpt-4o" },
        })
      )
    })

    it("plans Auto from the existing settings contract", async () => {
      primeTextChannel(["ok"])
      await executeAgent("分析这段代码", {
        autoRouting: {
          enabled: true,
          defaultSelection: "auto",
          candidateAliases: ["fast", "balanced", "powerful"],
          thresholds: { balanced: 0.35, powerful: 0.7 },
          strategy: "reliability",
          dataPolicy: { locality: "any" },
          shadowMode: true,
        } as never,
      })
      expect(mockBuildRoutingEngine).toHaveBeenCalled()
      expect(mockPlanRoute).toHaveBeenCalledWith(
        expect.objectContaining({
          surface: "agent",
          selection: { kind: "auto" },
          promptText: "分析这段代码",
          strategy: "reliability",
          shadowMode: true,
        })
      )
    })

    it("fails closed before planning or dispatch when the full provider payload leaks PII", async () => {
      primeTextChannel()
      mockHasNoLeakingPiiDeep.mockReturnValue(false)

      await expect(
        executeAgent("contact alice@example.com", {
          priorMessages: [{ role: "assistant", content: "context" }],
          systemPrompt: "system",
        })
      ).rejects.toThrow("outbound prompt rejected by the PII gate")
      // The gate sees the partitioned payload — i.e. exactly what would be
      // handed to the provider, with the system prompt hoisted out of
      // `messages` into the top-level instructions list.
      expect(mockHasNoLeakingPiiDeep).toHaveBeenCalledWith({
        messages: [
          { role: "assistant", content: "context" },
          { role: "user", content: "contact alice@example.com" },
        ],
        instructions: [{ role: "system", content: "system" }],
      })
      expect(mockPlanRoute).not.toHaveBeenCalled()
      expect(mockStreamText).not.toHaveBeenCalled()
    })

    it("hydrates the existing in-memory routing policy for public Agent callers", async () => {
      primeTextChannel(["ok"])
      mockLiveSettingsState.settings = {
        defaultProvider: "openai",
        providerSettings: { openai: { enabled: true, apiKey: "sk-live" } },
        modelMappings: [],
        routingConfig: { strategy: "reliability", maxFallbackAttempts: 1 },
        autoRouting: {
          enabled: true,
          defaultSelection: "auto",
          candidateAliases: ["fast", "balanced", "powerful"],
          thresholds: { balanced: 0.35, powerful: 0.7 },
          strategy: "reliability",
          dataPolicy: { locality: "any" },
        },
      }

      await executeAgent("route from live settings")

      expect(mockPlanRoute).toHaveBeenCalledWith(
        expect.objectContaining({ surface: "agent", selection: { kind: "auto" } })
      )
      expect(mockApplyCircuitBreakerSettings).toHaveBeenCalledWith(
        expect.objectContaining({ strategy: "reliability" })
      )
    })

    it("plans an explicit alias without resolving it as a concrete model", async () => {
      primeTextChannel(["ok"])

      await executeAgent("review this", {
        model: "coding",
        modelMappings: [
          {
            id: "coding",
            alias: "coding",
            providers: [{ providerId: "openai", modelId: "gpt-4o" }],
            distribution: "priority",
            enabled: true,
            createdAt: 1,
            updatedAt: 1,
          },
        ],
      })

      expect(mockPlanRoute).toHaveBeenCalledWith(
        expect.objectContaining({ selection: { kind: "alias", alias: "coding" } })
      )
    })

    it("falls back only when a candidate fails before the first text delta", async () => {
      primeTextChannel()
      mockPlanRoute.mockResolvedValue(
        routingPlan([
          { providerId: "openai", modelId: "gpt-4o" },
          { providerId: "anthropic", modelId: "claude-sonnet-4-5" },
        ])
      )
      mockStreamText
        .mockReturnValueOnce({
          textStream: (async function* () {
            throw new Error("connection reset")
          })(),
          finishReason: Promise.resolve("error"),
        } as never)
        .mockReturnValueOnce({
          textStream: (async function* () {
            yield "recovered"
          })(),
          finishReason: Promise.resolve("stop"),
        } as never)

      await expect(executeAgent("hi")).resolves.toMatchObject({ text: "recovered" })
      expect(mockStreamText).toHaveBeenCalledTimes(2)
      expect(mockCreateModel).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ model: "claude-sonnet-4-5" })
      )
    })

    it("never replays automatically after the first text delta is committed", async () => {
      primeTextChannel()
      mockPlanRoute.mockResolvedValue(
        routingPlan([
          { providerId: "openai", modelId: "gpt-4o" },
          { providerId: "anthropic", modelId: "claude-sonnet-4-5" },
        ])
      )
      const onDelta = jest.fn()
      mockStreamText.mockReturnValue({
        textStream: (async function* () {
          yield "partial"
          throw new Error("stream interrupted")
        })(),
        finishReason: Promise.resolve("error"),
      } as never)

      await expect(executeAgent("hi", { onDelta })).rejects.toThrow("stream interrupted")
      expect(onDelta).toHaveBeenCalledWith("partial")
      expect(mockStreamText).toHaveBeenCalledTimes(1)
    })

    it("cancels an aborted attempt without trying the next candidate", async () => {
      primeTextChannel()
      mockPlanRoute.mockResolvedValue(
        routingPlan([
          { providerId: "openai", modelId: "gpt-4o" },
          { providerId: "anthropic", modelId: "claude-sonnet-4-5" },
        ])
      )
      const controller = new AbortController()
      controller.abort()
      mockStreamText.mockReturnValue({
        textStream: (async function* () {
          throw new Error("aborted")
        })(),
        finishReason: Promise.resolve("error"),
      } as never)

      await expect(executeAgent("hi", { abortSignal: controller.signal })).rejects.toThrow(
        "aborted"
      )
      expect(mockStreamText).toHaveBeenCalledTimes(1)
    })

    it("advances when a planned candidate cannot resolve credentials", async () => {
      primeTextChannel()
      mockPlanRoute.mockResolvedValue(
        routingPlan([
          { providerId: "openai", modelId: "gpt-4o" },
          { providerId: "anthropic", modelId: "claude-sonnet-4-5" },
        ])
      )
      const resolvedAttempt = {
        kind: "resolved",
        featureId: "plugin-agent-executor",
        routeProfile: "general-text",
        providerId: "anthropic",
        model: "claude-sonnet-4-5",
        apiKey: "sk-x",
        baseURL: "https://api.anthropic.com",
        protocol: "anthropic",
        isCustomProvider: false,
        executionMode: "direct-model",
        useProxy: false,
        attemptedProviderIds: ["anthropic"],
        fallbackProviderIds: [],
      } as never
      mockResolveProvider
        .mockReturnValueOnce(resolvedAttempt)
        .mockReturnValueOnce({
          kind: "blocked",
          reason: "missing key",
          nextAction: "add_api_key",
        } as never)
        .mockReturnValueOnce(resolvedAttempt)

      await expect(executeAgent("hi")).resolves.toMatchObject({ text: "hello" })
      expect(mockStreamText).toHaveBeenCalledTimes(1)
      expect(mockCreateModel).toHaveBeenCalledWith(
        expect.objectContaining({ model: "claude-sonnet-4-5" })
      )
    })

    it("forwards systemPrompt/temperature/abortSignal and tolerates a non-string finishReason", async () => {
      primeTextChannel(["x"], "stop")
      mockStreamText.mockReturnValue({
        textStream: (async function* () {
          yield "x"
        })(),
        finishReason: Promise.resolve(undefined),
      } as never)
      const controller = new AbortController()
      const result = await executeAgent("hi", {
        systemPrompt: "be brief",
        temperature: 0.2,
        abortSignal: controller.signal,
      })
      expect(result.finishReason).toBeUndefined()
      expect(mockStreamText).toHaveBeenCalledWith(
        expect.objectContaining({
          system: "be brief",
          temperature: 0.2,
          abortSignal: controller.signal,
        })
      )
    })

    it("replays priorMessages as a message list for text-channel multi-turn", async () => {
      primeTextChannel(["ans"])
      await executeAgent("follow-up", {
        priorMessages: [
          { role: "user", content: "first" },
          { role: "assistant", content: "reply" },
        ],
      })
      const opts = mockStreamText.mock.calls[0][0] as { messages?: unknown; prompt?: unknown }
      expect(opts.messages).toEqual([
        { role: "user", content: "first" },
        { role: "assistant", content: "reply" },
        { role: "user", content: "follow-up" },
      ])
      expect(opts.prompt).toBeUndefined()
    })

    it("uses a single prompt (no messages) when no priorMessages are given", async () => {
      primeTextChannel(["ans"])
      await executeAgent("solo")
      const opts = mockStreamText.mock.calls[0][0] as { messages?: unknown; prompt?: unknown }
      expect(opts.prompt).toBe("solo")
      expect(opts.messages).toBeUndefined()
    })

    it("throws when no provider resolves", async () => {
      mockResolveProvider.mockReturnValue({
        kind: "blocked",
        reason: "no key",
        nextAction: "add_api_key",
      } as never)
      await expect(executeAgent("hi")).rejects.toThrow(/executeAgent: no key/)
    })

    it("falls back to text-only when toolsEnabled but sidecar is unavailable", async () => {
      primeTextChannel(["web"])
      mockIsTauri.mockReturnValue(false)
      const result = await executeAgent("hi", { toolsEnabled: true })
      expect(result.channel).toBe("text")
      expect(result.toolsAvailable).toBe(false)
      expect(result.text).toBe("web")
      expect(mockRunAndCapture).not.toHaveBeenCalled()
    })

    it("routes a per-run provider override as the explicit resolveFeatureProvider id", async () => {
      primeTextChannel(["ok"])
      await executeAgent("hi", { provider: "anthropic" })
      expect(mockResolveProvider).toHaveBeenCalledWith(
        expect.objectContaining({ providerId: "anthropic", selectionMode: "explicit-provider" }),
        expect.anything()
      )
    })
  })

  describe("tool-enabled channel (sidecar)", () => {
    beforeEach(() => {
      mockIsTauri.mockReturnValue(true)
      mockCreateSession.mockResolvedValue({ id: "s1" } as never)
      mockGetSession.mockResolvedValue({ id: "s1" } as never)
      mockDeleteSession.mockResolvedValue(undefined as never)
      mockSetSdkSessionId.mockResolvedValue(undefined as never)
      mockGetSettings.mockResolvedValue({} as never)
      mockResolveSendOptions.mockResolvedValue({ model: "claude" } as never)
      mockRunAndCapture.mockResolvedValue({
        text: "tool-enabled reply",
        messageId: "m1",
        a2uiSurfaces: {},
        a2uiSurfaceOrder: [],
      })
    })

    it("routes through the sidecar and reports channel='sidecar', toolsAvailable=true", async () => {
      const result = await executeAgent("do work", { toolsEnabled: true, systemPrompt: "be terse" })
      expect(result.channel).toBe("sidecar")
      expect(result.toolsAvailable).toBe(true)
      expect(result.text).toBe("tool-enabled reply")
      expect(mockResolveSendOptions).toHaveBeenCalled()
      expect(mockRunAndCapture).toHaveBeenCalledWith(
        "s1",
        "do work",
        { model: "claude" },
        expect.objectContaining({ execution: expect.objectContaining({ kind: "subagent" }) })
      )
      expect(mockStreamText).not.toHaveBeenCalled()
      expect(mockResolveSendOptions).toHaveBeenCalledWith(
        expect.objectContaining({
          routingSurface: "agent",
          routingContextHint: { promptText: "do work" },
        })
      )
    })

    it("uses the shared plan to retry a tool rail failure before commitment", async () => {
      const plan = routingPlan([
        { providerId: "openai", modelId: "gpt-4o" },
        { providerId: "anthropic", modelId: "claude-sonnet-4-5" },
      ])
      mockGetSettings.mockResolvedValue({
        routingConfig: { maxFallbackAttempts: 1 },
      } as never)
      mockResolveSendOptions.mockResolvedValue({
        model: "gpt-4o",
        provider: "openai",
        routingPlan: plan,
      } as never)
      mockRunAndCapture
        .mockRejectedValueOnce(new Error("upstream unavailable"))
        .mockResolvedValueOnce({
          text: "fallback reply",
          messageId: "m2",
          a2uiSurfaces: {},
          a2uiSurfaceOrder: [],
        })

      await expect(executeAgent("do work", { toolsEnabled: true })).resolves.toMatchObject({
        text: "fallback reply",
      })
      expect(mockRunAndCapture).toHaveBeenCalledTimes(2)
      expect(mockRunAndCapture.mock.calls[1][2]).toMatchObject({
        provider: "anthropic",
        model: "claude-sonnet-4-5",
        providerCredentials: { apiKey: "sk-fallback", protocol: "anthropic" },
      })
      expect(mockResolveProviderAttemptOptions).toHaveBeenCalledWith(
        "anthropic",
        expect.any(Object)
      )
    })

    it("fails closed before a tool rail attempt when prompt assembly leaks PII", async () => {
      mockHasNoLeakingPiiDeep.mockReturnValue(false)
      mockResolveSendOptions.mockResolvedValue({
        model: "claude",
        systemPrompt: "system alice@example.com",
        appendSystemPrompt: "derived context",
      } as never)

      await expect(executeAgent("do work", { toolsEnabled: true })).rejects.toThrow(
        "outbound agent prompt rejected by the PII gate"
      )
      expect(mockHasNoLeakingPiiDeep).toHaveBeenCalledWith({
        prompt: "do work",
        systemPrompt: "system alice@example.com",
        appendSystemPrompt: "derived context",
      })
      expect(mockRunAndCapture).not.toHaveBeenCalled()
      expect(mockResolveProviderAttemptOptions).not.toHaveBeenCalled()
    })

    it("never retries the tool rail after a tool dispatch commits the attempt", async () => {
      const plan = routingPlan([
        { providerId: "openai", modelId: "gpt-4o" },
        { providerId: "anthropic", modelId: "claude-sonnet-4-5" },
      ])
      mockGetSettings.mockResolvedValue({
        routingConfig: { maxFallbackAttempts: 1 },
      } as never)
      mockResolveSendOptions.mockResolvedValue({
        model: "gpt-4o",
        provider: "openai",
        routingPlan: plan,
      } as never)
      mockRunAndCapture.mockImplementationOnce(async (_sessionId, _prompt, _options, capture) => {
        capture?.onEvent?.({ type: "tool-call", toolName: "Read", input: {} })
        throw new Error("failed after tool dispatch")
      })

      await expect(executeAgent("do work", { toolsEnabled: true })).rejects.toThrow(
        "failed after tool dispatch"
      )
      expect(mockRunAndCapture).toHaveBeenCalledTimes(1)
      expect(mockResolveProviderAttemptOptions).not.toHaveBeenCalled()
    })

    it("forwards a parent permissionCeiling into resolveSendOptions (child clamp)", async () => {
      await executeAgent("x", {
        toolsEnabled: true,
        permissionCeiling: { allowedTools: ["Read"], permissionMode: "plan" },
      })
      const ctx = mockResolveSendOptions.mock.calls[0][0]
      expect(ctx.permissionCeiling).toEqual({ allowedTools: ["Read"], permissionMode: "plan" })
    })

    it("omits permissionCeiling from resolveSendOptions when none is given", async () => {
      await executeAgent("x", { toolsEnabled: true })
      const ctx = mockResolveSendOptions.mock.calls[0][0]
      expect(ctx).not.toHaveProperty("permissionCeiling")
    })

    it("threads isDispatchedSubagent into resolveSendOptions (leaf-gate signal)", async () => {
      await executeAgent("x", { toolsEnabled: true, isDispatchedSubagent: true })
      expect(mockResolveSendOptions.mock.calls[0][0]).toMatchObject({
        isDispatchedSubagent: true,
      })
      // Absent for a plain (non-dispatched) plugin run.
      await executeAgent("x", { toolsEnabled: true })
      expect(mockResolveSendOptions.mock.calls[1][0]).not.toHaveProperty("isDispatchedSubagent")
    })

    it("routes a cross-provider run via the session's providerOverride", async () => {
      await executeAgent("x", { toolsEnabled: true, provider: "anthropic" })
      const ctx = mockResolveSendOptions.mock.calls[0][0]
      expect((ctx.session as { providerOverride?: string }).providerOverride).toBe("anthropic")
    })

    it("leaves the session provider untouched when no override is given", async () => {
      await executeAgent("x", { toolsEnabled: true })
      const ctx = mockResolveSendOptions.mock.calls[0][0]
      expect((ctx.session as { providerOverride?: string }).providerOverride).toBeUndefined()
    })

    it("synthesises a character when no characterId is given", async () => {
      await executeAgent("x", {
        toolsEnabled: true,
        model: "claude-opus-4-8",
        allowedTools: ["Bash"],
      })
      const ctx = mockResolveSendOptions.mock.calls[0][0]
      expect(ctx.character?.id).toBe("__plugin-agent__")
      expect(ctx.character?.model).toBe("claude-opus-4-8")
      expect(ctx.character?.allowedTools).toEqual(["Bash"])
    })

    it("synthesises a minimal character (systemPrompt + cwd, no model/tools)", async () => {
      await executeAgent("x", { toolsEnabled: true, systemPrompt: "scoped", cwd: "/repo" })
      const ctx = mockResolveSendOptions.mock.calls[0][0]
      expect(ctx.character?.systemPrompt).toBe("scoped")
      expect(ctx.character?.workingDir).toBe("/repo")
      expect(ctx.character?.model).toBeUndefined()
      expect(ctx.character?.allowedTools).toBeUndefined()
    })

    it("falls back to a default system prompt when none is supplied", async () => {
      await executeAgent("x", { toolsEnabled: true })
      const ctx = mockResolveSendOptions.mock.calls[0][0]
      expect(ctx.character?.systemPrompt).toMatch(/helpful agent/i)
    })

    it("resolves an existing character by id", async () => {
      mockResolveCharacter.mockResolvedValue({ id: "char-1", name: "Persona" } as never)
      await executeAgent("x", { toolsEnabled: true, characterId: "char-1" })
      expect(mockResolveCharacter).toHaveBeenCalledWith("char-1")
      const ctx = mockResolveSendOptions.mock.calls[0][0]
      expect(ctx.character?.id).toBe("char-1")
    })

    it("throws when characterId cannot be resolved", async () => {
      mockResolveCharacter.mockResolvedValue(null as never)
      await expect(
        executeAgent("x", { toolsEnabled: true, characterId: "missing" })
      ).rejects.toThrow(/character "missing" not found/)
    })

    it("reuses an existing persistent session, persists its sdkSessionId, and does not delete it", async () => {
      mockGetSession.mockResolvedValue({ id: "sess-x", characterId: "char-1" } as never)
      mockResolveCharacter.mockResolvedValue({ id: "char-1", name: "Persona" } as never)
      mockRunAndCapture.mockResolvedValue({
        text: "ok",
        messageId: "m1",
        a2uiSurfaces: {},
        a2uiSurfaceOrder: [],
        sdkSessionId: "sdk-123",
      })
      await executeAgent("x", { toolsEnabled: true, sessionId: "sess-x" })
      expect(mockCreateSession).not.toHaveBeenCalled()
      expect(mockRunAndCapture.mock.calls[0][0]).toBe("sess-x")
      expect(mockSetSdkSessionId).toHaveBeenCalledWith("sess-x", "sdk-123")
      expect(mockDeleteSession).not.toHaveBeenCalled()
    })

    it("throws when the persistent session id is not found", async () => {
      mockGetSession.mockResolvedValue(undefined as never)
      await expect(executeAgent("x", { toolsEnabled: true, sessionId: "missing" })).rejects.toThrow(
        /session "missing" not found/
      )
    })

    it("tears down the ephemeral session even when the run fails", async () => {
      mockRunAndCapture.mockRejectedValue(new Error("boom"))
      await expect(executeAgent("x", { toolsEnabled: true })).rejects.toThrow("boom")
      expect(mockDeleteSession).toHaveBeenCalledWith("s1")
    })

    it("forwards an explicit timeout to the runner", async () => {
      await executeAgent("x", { toolsEnabled: true, timeoutMs: 1234 })
      const capArg = mockRunAndCapture.mock.calls[0][3]
      expect(capArg).toMatchObject({ timeoutMs: 1234 })
    })

    it("appends system + structured instruction onto sendOptions.appendSystemPrompt", async () => {
      mockResolveSendOptions.mockResolvedValue({
        model: "claude",
        appendSystemPrompt: "BASE",
      } as never)
      await executeAgent("x", {
        toolsEnabled: true,
        appendSystem: "EXTRA",
        outputFormat: { type: "json_schema", schema: { ok: "boolean" } },
      })
      const sendOpts = mockRunAndCapture.mock.calls[0][2] as { appendSystemPrompt: string }
      expect(sendOpts.appendSystemPrompt).toContain("BASE")
      expect(sendOpts.appendSystemPrompt).toContain("EXTRA")
      expect(sendOpts.appendSystemPrompt).toMatch(/JSON/i)
    })

    it("forwards onEvent and a canUseTool-derived permission responder to the runner", async () => {
      const onEvent = jest.fn()
      const canUseTool = jest.fn(async () => ({ behavior: "allow" as const }))
      await executeAgent("x", { toolsEnabled: true, onEvent, canUseTool })
      const capArg = mockRunAndCapture.mock.calls[0][3] as {
        onEvent?: (e: unknown) => void
        onPermissionRequest?: (r: unknown) => Promise<unknown>
      }
      // onEvent is now wrapped (to also drive onPostToolUse), so it forwards
      // rather than being the same reference.
      expect(typeof capArg.onEvent).toBe("function")
      capArg.onEvent?.({ type: "text-delta", delta: "hi" })
      expect(onEvent).toHaveBeenCalledWith({ type: "text-delta", delta: "hi" })
      expect(typeof capArg.onPermissionRequest).toBe("function")
      // The responder adapts the gate's allow/deny → approveTool decision shape.
      const decision = await capArg.onPermissionRequest!({ toolName: "t", input: { a: 1 } })
      expect(canUseTool).toHaveBeenCalledWith("t", { a: 1 }, expect.any(Object))
      expect(decision).toEqual({ decision: "allow", updatedInput: undefined })
    })

    it("does not attach a permission responder when no canUseTool is given", async () => {
      await executeAgent("x", { toolsEnabled: true })
      const capArg = mockRunAndCapture.mock.calls[0][3] as { onPermissionRequest?: unknown }
      expect(capArg.onPermissionRequest).toBeUndefined()
    })

    it("wires onPostToolUse as a tool-result review responder + enables review on sendOptions", async () => {
      const onPostToolUse = jest.fn(async () => ({ updatedToolOutput: "CLEAN" }))
      await executeAgent("x", { toolsEnabled: true, onPostToolUse })
      const sendOpts = mockRunAndCapture.mock.calls[0][2] as { toolResultReviewEnabled?: boolean }
      expect(sendOpts.toolResultReviewEnabled).toBe(true)
      const capArg = mockRunAndCapture.mock.calls[0][3] as {
        onToolResultReview?: (r: unknown) => Promise<{ updatedToolOutput?: unknown }>
      }
      expect(typeof capArg.onToolResultReview).toBe("function")
      const decision = await capArg.onToolResultReview!({
        toolName: "web_fetch",
        input: { url: "x" },
        result: "RAW",
        isError: false,
      })
      expect(onPostToolUse).toHaveBeenCalledWith(
        { toolName: "web_fetch", input: { url: "x" }, result: "RAW", isError: false },
        expect.any(Object)
      )
      expect(decision).toEqual({ updatedToolOutput: "CLEAN" })
    })

    it("does not enable review or attach a responder without onPostToolUse", async () => {
      await executeAgent("x", { toolsEnabled: true })
      const sendOpts = mockRunAndCapture.mock.calls[0][2] as { toolResultReviewEnabled?: boolean }
      const capArg = mockRunAndCapture.mock.calls[0][3] as { onToolResultReview?: unknown }
      expect(sendOpts.toolResultReviewEnabled).toBeUndefined()
      expect(capArg.onToolResultReview).toBeUndefined()
    })

    it("attaches an internal event observer even when no external onEvent is given", async () => {
      await executeAgent("x", { toolsEnabled: true })
      const capArg = mockRunAndCapture.mock.calls[0][3] as { onEvent?: unknown }
      expect(typeof capArg.onEvent).toBe("function")
    })

    it("parses structured output from the sidecar reply onto result.object", async () => {
      mockRunAndCapture.mockResolvedValue({
        text: '{"ok": true}',
        messageId: "m1",
        a2uiSurfaces: {},
        a2uiSurfaceOrder: [],
      })
      const result = await executeAgent("x", {
        toolsEnabled: true,
        outputFormat: { type: "json_schema", schema: { ok: "boolean" } },
      })
      expect(result.object).toEqual({ ok: true })
      expect(result.parseError).toBeUndefined()
    })
  })

  describe("structured output (text channel)", () => {
    it("parses a JSON reply onto result.object", async () => {
      primeTextChannel(['{"a":', " 1}"])
      const result = await executeAgent("hi", {
        outputFormat: { type: "json_schema", schema: { a: "number" } },
      })
      expect(result.object).toEqual({ a: 1 })
      expect(result.parseError).toBeUndefined()
      // The JSON instruction was appended to the system prompt.
      expect(mockStreamText).toHaveBeenCalledWith(
        expect.objectContaining({ system: expect.stringMatching(/JSON/i) })
      )
    })

    it("surfaces parseError (never throws) when the reply is not JSON", async () => {
      primeTextChannel(["totally not json"])
      const result = await executeAgent("hi", {
        outputFormat: { type: "json_schema", schema: { a: "number" } },
      })
      expect(result.object).toBeUndefined()
      expect(typeof result.parseError).toBe("string")
    })

    it("emits text-delta events through onEvent on the text channel", async () => {
      primeTextChannel(["foo", "bar"])
      const events: Array<{ type: string; delta?: string }> = []
      await executeAgent("hi", { onEvent: (e) => events.push(e) })
      expect(events).toEqual([
        { type: "text-delta", delta: "foo" },
        { type: "text-delta", delta: "bar" },
      ])
    })

    it("composes systemPrompt + appendSystem", async () => {
      primeTextChannel(["x"])
      await executeAgent("hi", { systemPrompt: "BASE", appendSystem: "EXTRA" })
      expect(mockStreamText).toHaveBeenCalledWith(
        expect.objectContaining({ system: "BASE\n\nEXTRA" })
      )
    })
  })

  describe("ADR-0090 resolver flag delegation", () => {
    afterEach(() => {
      delete process.env.NEXT_PUBLIC_AGENT_EXECUTION_RESOLVER_V2
    })

    it("delegates to the unified service when agentExecutionResolverV2 is on", async () => {
      process.env.NEXT_PUBLIC_AGENT_EXECUTION_RESOLVER_V2 = "1"
      // Web environment (isTauri=false) + legacy toolsEnabled:true maps to the
      // explicit completion fallback — the service runs the completion rail and
      // stamps degradedReason instead of silently degrading.
      primeTextChannel(["ok"])
      const result = (await executeAgent("hi", { toolsEnabled: true })) as Awaited<
        ReturnType<typeof executeAgent>
      > & { degradedReason?: string; runtime?: string }
      expect(result.text).toBe("ok")
      expect(result.channel).toBe("text")
      expect(result.degradedReason).toBe("legacy-completion-fallback")
      expect(result.runtime).toBe("claude-agent-sdk")
    })

    it("keeps the legacy branch byte-identical when the flag is off", async () => {
      primeTextChannel(["ok"])
      const result = (await executeAgent("hi", { toolsEnabled: true })) as Awaited<
        ReturnType<typeof executeAgent>
      > & { degradedReason?: string }
      expect(result.text).toBe("ok")
      expect(result.channel).toBe("text")
      expect(result.degradedReason).toBeUndefined()
    })
  })
})

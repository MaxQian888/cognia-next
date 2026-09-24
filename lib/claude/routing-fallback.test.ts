// Unit tests for the renderer-side routing fallback retry helper.
//
// The helper reads from `useChatStore.lastSendBySession`, classifies the
// error string, swaps in the next provider/model from the alias's fallback
// chain, and re-issues the turn through the IPC. Tests drive the cache
// directly and assert against `sendPrompt` mock calls + cache mutations.

import { useChatStore } from "@/stores/chat"
import { useSettingsStore } from "@/stores/settings"
import { attemptRoutingFallback, classifyError } from "./routing-fallback"
import type { SendOptions } from "@cognia/agent-config-types"

const sendPromptMock = jest.fn<Promise<void>, unknown[]>()

jest.mock("@/lib/claude/ipc", () => ({
  sendPrompt: (...args: unknown[]) => sendPromptMock(...args),
}))

const dispatchDiagnosticMock = jest.fn()
jest.mock("@/lib/diagnostics/bus", () => ({
  dispatchDiagnostic: (...args: unknown[]) => dispatchDiagnosticMock(...args),
}))

const getSessionMock = jest.fn()
const getCharacterMock = jest.fn()
const codexCredentialMock = jest.fn()
const opencodeCredentialMock = jest.fn()
const managedCredentialMock = jest.fn()
jest.mock("@/lib/subscription/core/managed-key-credential", () => ({
  resolveManagedSubscriptionCredential: (...args: unknown[]) => managedCredentialMock(...args),
}))
jest.mock("@/lib/db/sessions", () => ({
  getSession: (...args: unknown[]) => getSessionMock(...args),
}))
jest.mock("@/lib/db/characters", () => ({
  getCharacter: (...args: unknown[]) => getCharacterMock(...args),
}))
jest.mock("@/lib/subscription/codex/chat-bridge", () => ({
  resolveCodexVaultCredential: (...args: unknown[]) => codexCredentialMock(...args),
}))
jest.mock("@/lib/subscription/opencode/chat-bridge", () => ({
  resolveOpencodeVaultCredential: (...args: unknown[]) => opencodeCredentialMock(...args),
}))
// Router + Fusion (ADR-0188) reroute seam; untouched by every unledgered turn.
const rerouteRouterFusionSendMock = jest.fn()
const abortRouterFusionSendMock = jest.fn(async (..._args: unknown[]) => undefined)
jest.mock("@/lib/router-fusion/gate/chat-send", () => ({
  ...jest.requireActual("@/lib/router-fusion/gate/chat-send"),
  rerouteRouterFusionSend: (...args: unknown[]) => rerouteRouterFusionSendMock(...args),
  abortRouterFusionSend: (...args: unknown[]) => abortRouterFusionSendMock(...args),
}))

const baseOptions = (
  fallbackEntries: Array<{ providerId: string; modelId: string }>
): SendOptions =>
  ({
    provider: fallbackEntries[0]?.providerId,
    model: fallbackEntries[0]?.modelId,
    aliasResolution: fallbackEntries.length
      ? {
          alias: "fast",
          resolvedTo: {
            providerId: fallbackEntries[0].providerId,
            modelId: fallbackEntries[0].modelId,
          },
          fallbackEntries,
        }
      : undefined,
  }) as SendOptions

function seedCache(
  sessionId: string,
  fallbackEntries: Array<{ providerId: string; modelId: string }>,
  attemptIndex = 0
) {
  useChatStore.getState().setLastSend(sessionId, {
    content: "hello",
    options: baseOptions(fallbackEntries),
    attemptIndex,
  })
}

function setRoutingEnabled(enabled: boolean) {
  // Mutate settings directly. The real store wires through saveSettings
  // (Dexie) but the helper only reads `routingFallbackEnabled` so the
  // simpler path is fine for unit tests.
  // @ts-expect-error — narrow the partial settings shape for test purposes.
  useSettingsStore.setState({ settings: { routingFallbackEnabled: enabled } })
}

describe("classifyError", () => {
  it.each([
    ["Request timeout after 30s", "transient"],
    ["HTTPError 429: rate_limit_error", "transient"],
    ["fetch failed: ECONNRESET", "transient"],
    ["upstream returned 502", "transient"],
    ["service_unavailable", "transient"],
    ["overloaded", "transient"],
    ["provider_error: bad gateway", "transient"],
  ])("classifies %p as transient", (msg, expected) => {
    expect(classifyError(msg)).toBe(expected)
  })

  it.each([
    ["unauthorized: invalid api key", "permanent"],
    ["401: missing token", "permanent"],
    ["invalid_request: model unknown", "permanent"],
    ["missing_credential", "permanent"],
    ["unknown weird thing", "permanent"], // unknown → permanent (fail-safe)
  ])("classifies %p as permanent", (msg, expected) => {
    expect(classifyError(msg)).toBe(expected)
  })
})

describe("attemptRoutingFallback", () => {
  beforeEach(() => {
    sendPromptMock.mockReset()
    sendPromptMock.mockResolvedValue(undefined)
    dispatchDiagnosticMock.mockClear()
    useChatStore.getState().clear()
    setRoutingEnabled(true)
  })

  it("discloses the provider substitution once the retry is actually in flight", async () => {
    // The turn is now running somewhere the user did not choose, which changes
    // cost and output quality. The previous English `toast.message(...)` fired
    // BEFORE the retry was issued, so it announced a swap that could still fail.
    seedCache("s1", [
      { providerId: "openai", modelId: "gpt-4o-mini" },
      { providerId: "anthropic", modelId: "claude-haiku-4-5" },
    ])
    await attemptRoutingFallback("s1", "rate limit exceeded")

    expect(dispatchDiagnosticMock).toHaveBeenCalledTimes(1)
    expect(dispatchDiagnosticMock.mock.calls[0][0]).toMatchObject({
      code: "degradedFallback",
      source: "provider",
      severity: "info",
      meta: { sessionId: "s1", providerId: "anthropic", modelId: "claude-haiku-4-5" },
    })
  })

  it("uses the fallback model's discovered limits and preserves a smaller turn output cap", async () => {
    useSettingsStore.setState({
      settings: {
        routingFallbackEnabled: true,
        providerSettings: {
          openai: {
            enabled: true,
            apiKey: "test",
            defaultModel: "provider-default",
            inferenceDefaults: { maxTokens: 10000 },
            discoveredModels: [
              { id: "fallback-model", contextLength: 64000, maxOutputTokens: 4096 },
            ],
          },
        },
      } as never,
    })
    const entries = [
      { providerId: "anthropic", modelId: "initial-model" },
      { providerId: "openai", modelId: "fallback-model" },
    ]
    useChatStore.getState().setLastSend("s1", {
      content: "hello",
      attemptIndex: 0,
      options: {
        ...baseOptions(entries),
        compaction: { enabled: true, contextWindow: 200000 } as SendOptions["compaction"],
        modelParams: { maxOutputTokens: 1024 },
      },
    })
    await expect(attemptRoutingFallback("s1", "rate limit exceeded")).resolves.toBe(true)
    const cached = useChatStore.getState().lastSendBySession.s1
    expect(cached?.options.compaction?.contextWindow).toBe(64000 - 1024)
    expect(cached?.options.modelParams?.maxOutputTokens).toBe(1024)
  })

  it("keeps an addressed turn's route stamp across the provider swap", async () => {
    const routeStamp = { handle: "claude", label: "Claude", runtimeKind: "builtin" as const }
    useChatStore.getState().setLastSend("s1", {
      content: "hello",
      options: baseOptions([
        { providerId: "openai", modelId: "gpt-4o-mini" },
        { providerId: "anthropic", modelId: "claude-haiku-4-5" },
      ]),
      attemptIndex: 0,
      routeStamp,
    })
    await expect(attemptRoutingFallback("s1", "rate limit exceeded")).resolves.toBe(true)
    expect(useChatStore.getState().lastSendBySession.s1?.routeStamp).toEqual(routeStamp)

    // An unaddressed turn gains no stamp.
    seedCache("s2", [
      { providerId: "openai", modelId: "gpt-4o-mini" },
      { providerId: "anthropic", modelId: "claude-haiku-4-5" },
    ])
    await attemptRoutingFallback("s2", "rate limit exceeded")
    expect(useChatStore.getState().lastSendBySession.s2).not.toHaveProperty("routeStamp")
  })

  it("stays silent when the retry itself could not be issued", async () => {
    seedCache("s1", [
      { providerId: "openai", modelId: "gpt-4o-mini" },
      { providerId: "anthropic", modelId: "claude-haiku-4-5" },
    ])
    sendPromptMock.mockRejectedValueOnce(new Error("ipc down"))
    await attemptRoutingFallback("s1", "rate limit exceeded")
    expect(dispatchDiagnosticMock).not.toHaveBeenCalled()
  })

  it("returns false when routingFallbackEnabled is false", async () => {
    setRoutingEnabled(false)
    seedCache("s1", [
      { providerId: "openai", modelId: "gpt-4o-mini" },
      { providerId: "anthropic", modelId: "claude-haiku-4-5" },
    ])
    const result = await attemptRoutingFallback("s1", "rate limit exceeded")
    expect(result).toBe(false)
    expect(sendPromptMock).not.toHaveBeenCalled()
  })

  it("returns false when no cache entry exists for the session", async () => {
    const result = await attemptRoutingFallback("missing", "503")
    expect(result).toBe(false)
    expect(sendPromptMock).not.toHaveBeenCalled()
  })

  it("returns false when fallbackEntries is empty", async () => {
    seedCache("s1", [])
    const result = await attemptRoutingFallback("s1", "503")
    expect(result).toBe(false)
    expect(sendPromptMock).not.toHaveBeenCalled()
  })

  it("returns false on permanent errors", async () => {
    seedCache("s1", [
      { providerId: "openai", modelId: "gpt-4o-mini" },
      { providerId: "anthropic", modelId: "claude-haiku-4-5" },
    ])
    const result = await attemptRoutingFallback("s1", "401 unauthorized")
    expect(result).toBe(false)
    expect(sendPromptMock).not.toHaveBeenCalled()
  })

  it("retries on transient errors and swaps provider+model", async () => {
    seedCache("s1", [
      { providerId: "openai", modelId: "gpt-4o-mini" },
      { providerId: "anthropic", modelId: "claude-haiku-4-5" },
    ])
    const result = await attemptRoutingFallback("s1", "rate limit exceeded")
    expect(result).toBe(true)
    expect(sendPromptMock).toHaveBeenCalledTimes(1)
    const [sessionId, content, options] = sendPromptMock.mock.calls[0] as [
      string,
      unknown,
      SendOptions,
    ]
    expect(sessionId).toBe("s1")
    expect(content).toBe("hello")
    expect(options.provider).toBe("anthropic")
    expect(options.model).toBe("claude-haiku-4-5")
    expect(options.aliasResolution?.resolvedTo).toEqual({
      providerId: "anthropic",
      modelId: "claude-haiku-4-5",
    })
  })

  it("resolves credentials again for the fallback provider", async () => {
    useSettingsStore.setState({
      settings: {
        routingFallbackEnabled: true,
        defaultProvider: "openai",
        providerSettings: {
          openai: { apiKey: "sk-primary" },
          groq: { apiKey: "sk-fallback" },
        },
      } as never,
    })
    seedCache("s1", [
      { providerId: "openai", modelId: "gpt-4o-mini" },
      { providerId: "groq", modelId: "llama" },
    ])
    const cached = useChatStore.getState().lastSendBySession.s1!
    useChatStore.getState().setLastSend("s1", {
      ...cached,
      options: {
        ...cached.options,
        providerCredentials: { apiKey: "sk-primary", protocol: "openai" },
      },
    })

    await attemptRoutingFallback("s1", "rate limit exceeded")
    const options = sendPromptMock.mock.calls[0]?.[2] as SendOptions
    expect(options.providerCredentials).toMatchObject({
      apiKey: "sk-fallback",
      protocol: "openai",
    })
    expect(options.providerCredentials?.apiKey).not.toBe("sk-primary")
  })

  it("retries using the structured httpStatus when the message is unclassifiable", async () => {
    seedCache("s1", [
      { providerId: "openai", modelId: "gpt-4o-mini" },
      { providerId: "anthropic", modelId: "claude-haiku-4-5" },
    ])
    // Message matches no transient pattern, but the real status is 429.
    const result = await attemptRoutingFallback("s1", "upstream connect error", {
      httpStatus: 429,
    })
    expect(result).toBe(true)
    expect(sendPromptMock).toHaveBeenCalledTimes(1)
  })

  it("does NOT retry an unclassifiable message with no structured status", async () => {
    seedCache("s1", [
      { providerId: "openai", modelId: "gpt-4o-mini" },
      { providerId: "anthropic", modelId: "claude-haiku-4-5" },
    ])
    const result = await attemptRoutingFallback("s1", "upstream connect error")
    expect(result).toBe(false)
    expect(sendPromptMock).not.toHaveBeenCalled()
  })

  it("never retries after the turn has emitted visible output or a tool frame", async () => {
    seedCache("s1", [
      { providerId: "openai", modelId: "gpt-4o-mini" },
      { providerId: "anthropic", modelId: "claude-haiku-4-5" },
    ])
    useChatStore.getState().markLastSendCommitted("s1")

    await expect(attemptRoutingFallback("s1", "503")).resolves.toBe(false)
    expect(sendPromptMock).not.toHaveBeenCalled()
  })

  it("bumps attemptIndex in the cache before issuing the IPC", async () => {
    seedCache("s1", [
      { providerId: "openai", modelId: "gpt-4o-mini" },
      { providerId: "anthropic", modelId: "claude-haiku-4-5" },
    ])
    await attemptRoutingFallback("s1", "ECONNRESET")
    expect(useChatStore.getState().lastSendBySession.s1?.attemptIndex).toBe(1)
  })

  it("returns false and clears cache when chain is exhausted", async () => {
    seedCache(
      "s1",
      [
        { providerId: "openai", modelId: "gpt-4o-mini" },
        { providerId: "anthropic", modelId: "claude-haiku-4-5" },
      ],
      1
    )
    const result = await attemptRoutingFallback("s1", "rate limit exceeded")
    expect(result).toBe(false)
    expect(useChatStore.getState().lastSendBySession.s1).toBeUndefined()
  })

  it("does not affect a different session's cache", async () => {
    seedCache("s1", [
      { providerId: "openai", modelId: "gpt-4o-mini" },
      { providerId: "anthropic", modelId: "claude-haiku-4-5" },
    ])
    seedCache("s2", [
      { providerId: "openai", modelId: "gpt-4o-mini" },
      { providerId: "anthropic", modelId: "claude-haiku-4-5" },
    ])
    await attemptRoutingFallback("s1", "503")
    expect(useChatStore.getState().lastSendBySession.s1?.attemptIndex).toBe(1)
    expect(useChatStore.getState().lastSendBySession.s2?.attemptIndex).toBe(0)
  })

  it("returns false (caller surfaces error) when the IPC throws", async () => {
    sendPromptMock.mockRejectedValueOnce(new Error("ipc dead"))
    seedCache("s1", [
      { providerId: "openai", modelId: "gpt-4o-mini" },
      { providerId: "anthropic", modelId: "claude-haiku-4-5" },
    ])
    const result = await attemptRoutingFallback("s1", "503")
    expect(result).toBe(false)
    // Cache is still bumped so a subsequent retry attempt sees the new index.
    expect(useChatStore.getState().lastSendBySession.s1?.attemptIndex).toBe(1)
  })
})

describe("attemptRoutingFallback — Router + Fusion ledgered turns (ADR-0188 D5)", () => {
  const stamp = { runId: "rf-1", providerId: "openai", modelId: "gpt-4o-mini" }
  const ledgered = (): SendOptions =>
    ({
      provider: "openai",
      model: "gpt-4o-mini",
      routerFusion: stamp,
      ledger: {
        runId: "rf-1",
        mode: "per_call",
        transportAttempts: 2,
        deploymentId: "openai::gpt-4o-mini",
      },
      aliasResolution: {
        alias: "fast",
        resolvedTo: { providerId: "openai", modelId: "gpt-4o-mini" },
        fallbackEntries: [
          { providerId: "openai", modelId: "gpt-4o-mini" },
          { providerId: "anthropic", modelId: "claude-haiku-4-5" },
          { providerId: "google", modelId: "gemini-flash" },
          { providerId: "mistral", modelId: "mistral-small" },
        ],
        specialFallbacks: {
          contentPolicy: [{ providerId: "local", modelId: "uncensored-model" }],
        },
      },
    }) as unknown as SendOptions

  const newRun = (options: SendOptions, runId: string): SendOptions =>
    ({
      ...options,
      routerFusion: { ...stamp, runId, providerId: options.provider },
    }) as unknown as SendOptions

  beforeEach(() => {
    sendPromptMock.mockReset().mockResolvedValue(undefined)
    dispatchDiagnosticMock.mockClear()
    getSessionMock.mockReset().mockResolvedValue({ id: "s1", projectId: "p1" })
    rerouteRouterFusionSendMock
      .mockReset()
      .mockImplementation(async (input: { options: SendOptions }) => ({
        kind: "send",
        options: newRun(input.options, `rf-${input.options.provider}`),
      }))
    abortRouterFusionSendMock.mockClear()
    useChatStore.getState().clear()
    setRoutingEnabled(true)
    useChatStore
      .getState()
      .setLastSend("s1", { content: "hello", options: ledgered(), attemptIndex: 0 })
  })

  it("routes the next candidate as a new ledgered run before sending it, visibly", async () => {
    expect(await attemptRoutingFallback("s1", "rate limit exceeded")).toBe(true)
    expect(rerouteRouterFusionSendMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "s1",
        workspaceId: "p1",
        options: expect.objectContaining({ provider: "anthropic", model: "claude-haiku-4-5" }),
      })
    )
    const sent = sendPromptMock.mock.calls[0][2] as SendOptions
    expect(sent.routerFusion?.runId).toBe("rf-anthropic")
    expect(sent.fallbackModel).toBeUndefined()
    expect(rerouteRouterFusionSendMock.mock.invocationCallOrder[0]).toBeLessThan(
      sendPromptMock.mock.invocationCallOrder[0]
    )
    const cached = useChatStore.getState().lastSendBySession.s1
    expect(cached?.options.routerFusion?.runId).toBe("rf-anthropic")
    expect(cached?.routerFusionReroutes).toBe(1)
    expect(dispatchDiagnosticMock.mock.calls[0][0]).toMatchObject({ code: "degradedFallback" })
  })

  it("stops after two reroutes", async () => {
    expect(await attemptRoutingFallback("s1", "rate limit exceeded")).toBe(true)
    expect(await attemptRoutingFallback("s1", "rate limit exceeded")).toBe(true)
    expect(await attemptRoutingFallback("s1", "rate limit exceeded")).toBe(false)
    expect(sendPromptMock).toHaveBeenCalledTimes(2)
    expect(useChatStore.getState().lastSendBySession.s1?.routerFusionReroutes).toBe(2)
  })

  it("[ACC:CACHE-04] never reroutes a ledgered turn once a tool call or visible output went out", async () => {
    useChatStore.getState().markLastSendCommitted("s1")
    expect(await attemptRoutingFallback("s1", "rate limit exceeded")).toBe(false)
    expect(rerouteRouterFusionSendMock).not.toHaveBeenCalled()
    expect(sendPromptMock).not.toHaveBeenCalled()
  })

  it("never answers a content-policy refusal with another model", async () => {
    expect(await attemptRoutingFallback("s1", "blocked by content_policy")).toBe(false)
    expect(rerouteRouterFusionSendMock).not.toHaveBeenCalled()
    expect(sendPromptMock).not.toHaveBeenCalled()
  })

  it("[ACC:ISO-04] does not send a retry Router + Fusion refused", async () => {
    rerouteRouterFusionSendMock.mockResolvedValueOnce({
      kind: "refused",
      code: "ROUTE_NO_SOLUTION",
    })
    expect(await attemptRoutingFallback("s1", "rate limit exceeded")).toBe(false)
    expect(sendPromptMock).not.toHaveBeenCalled()
    expect(useChatStore.getState().lastSendBySession.s1?.options.routerFusion?.runId).toBe("rf-1")
  })

  it("[ACC:ISO-02] does not send a retry the fusion infrastructure could not route", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {})
    rerouteRouterFusionSendMock.mockRejectedValueOnce(new Error("fusion database unavailable"))
    expect(await attemptRoutingFallback("s1", "rate limit exceeded")).toBe(false)
    expect(sendPromptMock).not.toHaveBeenCalled()
    // The cache is untouched, so the turn keeps its original run.
    expect(useChatStore.getState().lastSendBySession.s1?.options.routerFusion?.runId).toBe("rf-1")
    expect(warn).toHaveBeenCalledWith("routing-fallback reroute failed", expect.any(Error))
    warn.mockRestore()
  })

  it("releases the new run when the retry could not be sent", async () => {
    sendPromptMock.mockRejectedValueOnce(new Error("ipc closed"))
    expect(await attemptRoutingFallback("s1", "rate limit exceeded")).toBe(false)
    expect(abortRouterFusionSendMock).toHaveBeenCalledWith(
      "s1",
      expect.objectContaining({ routerFusion: expect.objectContaining({ runId: "rf-anthropic" }) }),
      "ipc closed"
    )
  })

  it("[ACC:OFF-02] leaves an unledgered turn's fallback exactly as before", async () => {
    seedCache("s2", [
      { providerId: "openai", modelId: "gpt-4o-mini" },
      { providerId: "anthropic", modelId: "claude-haiku-4-5" },
    ])
    expect(await attemptRoutingFallback("s2", "rate limit exceeded")).toBe(true)
    expect(rerouteRouterFusionSendMock).not.toHaveBeenCalled()
    expect(useChatStore.getState().lastSendBySession.s2).not.toHaveProperty("routerFusionReroutes")
  })
})

describe("attemptRoutingFallback — error-class routing (P3.3)", () => {
  const specialOptions = (overrides: Record<string, unknown> = {}): SendOptions =>
    ({
      provider: "openai",
      model: "gpt-4o-mini",
      aliasResolution: {
        alias: "fast",
        resolvedTo: { providerId: "openai", modelId: "gpt-4o-mini" },
        fallbackEntries: [
          { providerId: "openai", modelId: "gpt-4o-mini" },
          { providerId: "anthropic", modelId: "claude-haiku-4-5" },
        ],
        specialFallbacks: {
          contextWindowExceeded: [
            { providerId: "google", modelId: "gemini-long-context" },
            { providerId: "anthropic", modelId: "claude-sonnet-4-6" },
          ],
          contentPolicy: [{ providerId: "local", modelId: "uncensored-model" }],
        },
        ...overrides,
      },
    }) as SendOptions

  beforeEach(() => {
    sendPromptMock.mockReset()
    sendPromptMock.mockResolvedValue(undefined)
    useChatStore.getState().clear()
    setRoutingEnabled(true)
  })

  it("routes a context-window failure through its dedicated chain, not the main one", async () => {
    useChatStore.getState().setLastSend("s1", {
      content: "hello",
      options: specialOptions(),
      attemptIndex: 0,
    })
    const result = await attemptRoutingFallback(
      "s1",
      "prompt is too long: 224864 tokens > 200000 maximum"
    )
    expect(result).toBe(true)
    const sent = sendPromptMock.mock.calls[0][2] as SendOptions
    expect(sent.provider).toBe("google")
    expect(sent.model).toBe("gemini-long-context")
    // Main-chain cursor untouched; special cursor advanced.
    const cached = useChatStore.getState().lastSendBySession.s1
    expect(cached?.attemptIndex).toBe(0)
    expect(cached?.specialAttempts?.contextWindowExceeded).toBe(1)
  })

  it("walks the special chain on repeated failures and exhausts it", async () => {
    useChatStore.getState().setLastSend("s1", {
      content: "hello",
      options: specialOptions(),
      attemptIndex: 0,
    })
    await attemptRoutingFallback("s1", "maximum context length exceeded")
    const second = await attemptRoutingFallback("s1", "maximum context length exceeded")
    expect(second).toBe(true)
    const sent = sendPromptMock.mock.calls[1][2] as SendOptions
    expect(sent.provider).toBe("anthropic")
    // Third failure: chain exhausted → no retry, cache cleared.
    const third = await attemptRoutingFallback("s1", "maximum context length exceeded")
    expect(third).toBe(false)
    expect(useChatStore.getState().lastSendBySession.s1).toBeUndefined()
  })

  it("routes content-policy failures to the contentPolicy chain", async () => {
    useChatStore.getState().setLastSend("s1", {
      content: "hello",
      options: specialOptions(),
      attemptIndex: 0,
    })
    const result = await attemptRoutingFallback("s1", "blocked by content_policy")
    expect(result).toBe(true)
    const sent = sendPromptMock.mock.calls[0][2] as SendOptions
    expect(sent.provider).toBe("local")
  })

  it("a special-class failure with NO dedicated chain never grinds the main chain", async () => {
    useChatStore.getState().setLastSend("s1", {
      content: "hello",
      options: specialOptions({ specialFallbacks: undefined }),
      attemptIndex: 0,
    })
    const result = await attemptRoutingFallback("s1", "prompt is too long")
    expect(result).toBe(false)
    expect(sendPromptMock).not.toHaveBeenCalled()
  })

  it("honors the per-class retry budget on the main chain", async () => {
    useChatStore.getState().setLastSend("s1", {
      content: "hello",
      options: specialOptions({
        retryPolicy: { "rate-limit": { maxRetries: 0 } },
      }),
      attemptIndex: 0,
    })
    // rate-limit budget 0 → no retry even though the chain has entries.
    const rateLimited = await attemptRoutingFallback("s1", "HTTPError 429: rate_limit_error")
    expect(rateLimited).toBe(false)
    expect(sendPromptMock).not.toHaveBeenCalled()
    // A timeout (no budget configured) still retries through the chain.
    const timedOut = await attemptRoutingFallback("s1", "Request timed out")
    expect(timedOut).toBe(true)
  })
})

describe("subscription account identity on routing retry", () => {
  beforeEach(() => {
    getSessionMock.mockReset()
    getCharacterMock.mockReset()
    codexCredentialMock.mockReset()
    opencodeCredentialMock.mockReset()
    sendPromptMock.mockClear().mockResolvedValue(undefined)
    useChatStore.getState().clear()
    useSettingsStore.setState({
      settings: {
        routingFallbackEnabled: true,
        defaultProvider: "codex",
        providerSettings: {
          codex: { providerId: "codex", enabled: true, apiKey: "manual-key" },
          opencode: { providerId: "opencode", enabled: true, apiKey: "other-provider-manual" },
        },
      } as never,
    })
  })

  it.each(["session", "character"])(
    "retains an explicit %s account when retrying another model on the same provider",
    async (source) => {
      getSessionMock.mockResolvedValue(
        source === "session" ? { id: "s1", accountId: "pinned" } : { id: "s1", characterId: "c1" }
      )
      getCharacterMock.mockResolvedValue({ accountIdOverride: "pinned" })
      codexCredentialMock.mockResolvedValue({
        apiKey: "pinned-key",
        baseURL: "https://selected.test",
      })
      seedCache("s1", [
        { providerId: "codex", modelId: "model-a" },
        { providerId: "codex", modelId: "model-b" },
      ])
      expect(await attemptRoutingFallback("s1", "rate limit exceeded")).toBe(true)
      expect(codexCredentialMock).toHaveBeenCalledWith("codex", "pinned")
      expect(sendPromptMock).toHaveBeenCalledWith(
        "s1",
        "hello",
        expect.objectContaining({
          providerCredentials: expect.objectContaining({ apiKey: "pinned-key" }),
        })
      )
    }
  )

  it("uses the new provider's manual/default credentials for a cross-provider retry", async () => {
    getSessionMock.mockResolvedValue({ id: "s1", accountId: "codex-pinned" })
    seedCache("s1", [
      { providerId: "codex", modelId: "model-a" },
      { providerId: "opencode", modelId: "model-b" },
    ])
    expect(await attemptRoutingFallback("s1", "rate limit exceeded")).toBe(true)
    expect(getSessionMock).not.toHaveBeenCalled()
    expect(sendPromptMock).toHaveBeenCalledWith(
      "s1",
      "hello",
      expect.objectContaining({
        providerCredentials: expect.objectContaining({ apiKey: "other-provider-manual" }),
      })
    )
  })

  it("does not carry the original provider pin into a second retry within another provider family", async () => {
    getSessionMock.mockResolvedValue({
      id: "s1",
      providerOverride: "codex",
      accountId: "codex-pinned",
    })
    seedCache("s1", [
      { providerId: "opencode", modelId: "model-a" },
      { providerId: "opencode", modelId: "model-b" },
    ])
    expect(await attemptRoutingFallback("s1", "rate limit exceeded")).toBe(true)
    expect(opencodeCredentialMock).not.toHaveBeenCalled()
    expect(sendPromptMock).toHaveBeenCalledWith(
      "s1",
      "hello",
      expect.objectContaining({
        providerCredentials: expect.objectContaining({ apiKey: "other-provider-manual" }),
      })
    )
  })

  it("keeps the selected account on routing-plan retries as well as legacy alias retries", async () => {
    getSessionMock.mockResolvedValue({ id: "s1", accountId: "pinned" })
    codexCredentialMock.mockResolvedValue({
      apiKey: "pinned-key",
      baseURL: "https://selected.test",
    })
    const entries = [
      { providerId: "codex", modelId: "model-a" },
      { providerId: "codex", modelId: "model-b" },
    ]
    useChatStore.getState().setLastSend("s1", {
      content: "hello",
      attemptIndex: 0,
      options: {
        ...baseOptions(entries),
        routingPlan: { decisionId: "decision", orderedCandidates: entries } as never,
      },
    })
    expect(await attemptRoutingFallback("s1", "rate limit exceeded")).toBe(true)
    expect(sendPromptMock).toHaveBeenCalledWith(
      "s1",
      "hello",
      expect.objectContaining({
        model: "model-b",
        providerCredentials: expect.objectContaining({ apiKey: "pinned-key" }),
      })
    )
  })

  it("does not retry when account ownership cannot be reloaded", async () => {
    getSessionMock.mockRejectedValue(new Error("account database locked"))
    seedCache("s1", [
      { providerId: "codex", modelId: "model-a" },
      { providerId: "codex", modelId: "model-b" },
    ])
    expect(await attemptRoutingFallback("s1", "rate limit exceeded")).toBe(false)
    expect(sendPromptMock).not.toHaveBeenCalled()
  })

  it("does not retry with a manual key when the pinned account disappeared", async () => {
    getSessionMock.mockResolvedValue({ id: "s1", accountId: "removed" })
    codexCredentialMock.mockResolvedValue(null)
    seedCache("s1", [
      { providerId: "codex", modelId: "model-a" },
      { providerId: "codex", modelId: "model-b" },
    ])
    expect(await attemptRoutingFallback("s1", "rate limit exceeded")).toBe(false)
    expect(sendPromptMock).not.toHaveBeenCalled()
  })
})

it("retains a custom subscription pin only within the same registered provider", async () => {
  useChatStore.getState().clear()
  const customProviders = ["custom-one", "custom-two"].map((id) => ({
    id,
    customName: id,
    baseURL: "https://example.com/v1",
    apiProtocol: "openai",
    customModels: ["model"],
    subscription: {},
  }))
  useSettingsStore.setState({
    settings: {
      routingFallbackEnabled: true,
      defaultProvider: "custom-one",
      customProviders,
    } as never,
  })
  getSessionMock.mockResolvedValue({
    id: "s1",
    providerOverride: "custom-one",
    accountId: "custom-pin",
  })
  managedCredentialMock
    .mockReset()
    .mockResolvedValue({ apiKey: "test", baseURL: "https://example.com/v1" })
  sendPromptMock.mockResolvedValue(undefined)
  seedCache("s1", [
    { providerId: "custom-one", modelId: "one" },
    { providerId: "custom-one", modelId: "two" },
  ])
  expect(await attemptRoutingFallback("s1", "rate limit exceeded")).toBe(true)
  expect(managedCredentialMock).toHaveBeenLastCalledWith(
    expect.objectContaining({ id: "custom-one" }),
    "custom-pin"
  )
  seedCache("s1", [
    { providerId: "custom-one", modelId: "one" },
    { providerId: "custom-two", modelId: "two" },
  ])
  expect(await attemptRoutingFallback("s1", "rate limit exceeded")).toBe(true)
  expect(managedCredentialMock).toHaveBeenLastCalledWith(
    expect.objectContaining({ id: "custom-two" }),
    null
  )
})

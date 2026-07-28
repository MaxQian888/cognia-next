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

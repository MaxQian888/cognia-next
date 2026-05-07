// Unit tests for the renderer-side routing fallback retry helper.
//
// The helper reads from `useChatStore.lastSendBySession`, classifies the
// error string, swaps in the next provider/model from the alias's fallback
// chain, and re-issues the turn through the IPC. Tests drive the cache
// directly and assert against `sendPrompt` mock calls + cache mutations.

import { useChatStore } from "@/stores/chat"
import { useSettingsStore } from "@/stores/settings"
import { attemptRoutingFallback, classifyError } from "./routing-fallback"
import type { SendOptions } from "./types"

const sendPromptMock = jest.fn<Promise<void>, unknown[]>()

jest.mock("@/lib/claude/ipc", () => ({
  sendPrompt: (...args: unknown[]) => sendPromptMock(...args),
}))

jest.mock("sonner", () => ({
  toast: {
    message: jest.fn(),
  },
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
    useChatStore.getState().clear()
    setRoutingEnabled(true)
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

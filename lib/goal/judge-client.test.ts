import { buildGoalJudgeClient } from "./judge-client"
import type { AppSettings, ChatSession } from "@cognia/agent-config-types"

/**
 * These tests run the real provider-resolution chain
 * (`createProviderSettingsSnapshot` + `resolveFeatureProvider`) — only the
 * eventual `createLlmClient` SDK import is lazy, so no network/SDK loads
 * until `.complete()` is called (which we never do here).
 */

function makeSettings(over: Record<string, unknown> = {}): AppSettings {
  return {
    defaultProvider: "anthropic",
    defaultModel: "claude-sonnet-4-6",
    providerSettings: { anthropic: { apiKey: "sk-test", enabled: true } },
    ...over,
  } as unknown as AppSettings
}

function makeSession(over: Record<string, unknown> = {}): ChatSession {
  return { id: "s1", ...over } as unknown as ChatSession
}

describe("buildGoalJudgeClient", () => {
  it("returns null when appSettings is missing", () => {
    expect(buildGoalJudgeClient(makeSession(), null)).toBeNull()
    expect(buildGoalJudgeClient(makeSession(), undefined)).toBeNull()
  })

  it("builds a client when the default provider resolves with a key", () => {
    const client = buildGoalJudgeClient(makeSession(), makeSettings())
    expect(client).not.toBeNull()
    expect(typeof client?.complete).toBe("function")
  })

  it("returns null when the resolved provider has no renderer key (legacy env path)", () => {
    // No providerSettings entry → resolveFeatureProvider can't find a key.
    const settings = makeSettings({ providerSettings: {} })
    expect(buildGoalJudgeClient(makeSession(), settings)).toBeNull()
  })

  it("returns null when no model can be determined", () => {
    const settings = makeSettings({ defaultModel: undefined })
    // Provider has a key but no defaultModel anywhere → null.
    const session = makeSession({ model: undefined })
    expect(buildGoalJudgeClient(session, settings)).toBeNull()
  })

  it("honors the session model and provider override", () => {
    const settings = makeSettings({
      providerSettings: {
        anthropic: { apiKey: "sk-a", enabled: true },
        openai: { apiKey: "sk-o", enabled: true },
      },
    })
    // override.provider picks openai even though defaultProvider is anthropic.
    const client = buildGoalJudgeClient(makeSession({ model: "gpt-x" }), settings, {
      provider: "openai",
      model: "gpt-judge",
    })
    expect(client).not.toBeNull()
  })

  it("returns null when the override provider is unconfigured", () => {
    const client = buildGoalJudgeClient(makeSession(), makeSettings(), { provider: "ghost" })
    expect(client).toBeNull()
  })
})

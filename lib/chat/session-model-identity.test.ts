import type { Character, ChatSession } from "@cognia/agent-config-types"

import { externalAgentProviderId } from "@/lib/ai/agent/external/session/session-models"
import { ANTHROPIC_DEFAULT_MODEL } from "@/lib/ai/provider-default-model"
import {
  resolveSessionModelIdentity,
  sessionAgentLane,
  sessionModelLabels,
} from "./session-model-identity"

function session(overrides: Partial<ChatSession> = {}): ChatSession {
  return {
    id: "s1",
    title: "s1",
    kind: "direct",
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  } as ChatSession
}

const names = (id: string) => ({ "claude-code": "Claude Code", kimi: "Kimi Code" })[id]

describe("sessionAgentLane", () => {
  it("trusts this device's own record first", () => {
    expect(
      sessionAgentLane(session({ externalAgentSession: { agentId: "kimi", sessionId: "x" } }), {
        sessionRuntimeRef: { kind: "builtin" },
        defaultRuntimeRef: { kind: "external", agentId: "codex" },
      })
    ).toBeNull()
  })

  /**
   * A conversation started on the desktop recorded no lane on the phone. Its
   * synced agent link says more about it than the phone's default.
   */
  it("prefers the conversation's synced agent link over this device's default", () => {
    expect(
      sessionAgentLane(session({ externalAgentSession: { agentId: "kimi", sessionId: "x" } }), {
        defaultRuntimeRef: { kind: "builtin" },
      })
    ).toEqual({ agentId: "kimi" })
    expect(
      sessionAgentLane(session({ providerOverride: externalAgentProviderId("kimi") }), {})
    ).toEqual({ agentId: "kimi" })
  })

  it("falls back to what the next turn would run on, like the composer chip", () => {
    expect(
      sessionAgentLane(session(), {
        defaultRuntimeRef: {
          kind: "host",
          configId: "cfg-1",
          revision: "r",
          lifecycleGeneration: 1,
          name: "Host Claude Code",
        },
      })
    ).toEqual({ agentId: "cfg-1", name: "Host Claude Code" })
    expect(sessionAgentLane(session(), { defaultRuntimeRef: { kind: "builtin" } })).toBeNull()
  })
})

describe("resolveSessionModelIdentity + sessionModelLabels", () => {
  it("keeps the built-in chain: conversation, then agent, then profile", () => {
    const character = { model: "gpt-5.6", providerId: "openai" } as Character
    expect(resolveSessionModelIdentity(session(), { character })).toEqual({
      lane: "builtin",
      modelId: "gpt-5.6",
      providerId: "openai",
    })
    expect(
      resolveSessionModelIdentity(
        session({ model: "claude-sonnet-5", providerOverride: "anthropic" }),
        {
          character,
        }
      )
    ).toMatchObject({ modelId: "claude-sonnet-5", providerId: "anthropic" })
    expect(resolveSessionModelIdentity(session(), { defaultModel: "gpt-5.6" })).toEqual({
      lane: "builtin",
      modelId: "gpt-5.6",
    })
  })

  it("names the built-in default and its provider only when nothing else is configured", () => {
    expect(resolveSessionModelIdentity(session(), {})).toEqual({
      lane: "builtin",
      modelId: ANTHROPIC_DEFAULT_MODEL,
      providerId: "anthropic",
    })
  })

  /**
   * A paired phone never has `defaultProvider` (desktop-only in settings
   * sync). The shared default model used to be named as Anthropic's.
   */
  it("does not invent a provider for a synced default model", () => {
    const identity = resolveSessionModelIdentity(session(), { defaultModel: "gpt-5.6" })
    expect(identity).not.toHaveProperty("providerId")
    const labels = sessionModelLabels(identity)
    expect(labels.provider).toBeUndefined()
    // Still a friendly name, found by scanning the catalog.
    expect(labels.model).not.toBe("gpt-5.6")
  })

  /** The bug: every agent conversation read "Claude Sonnet 5". */
  it("names the agent, not the built-in default, for an agent on its own model", () => {
    const identity = resolveSessionModelIdentity(
      session({ externalAgentSession: { agentId: "kimi", sessionId: "native-1" } }),
      { defaultModel: "claude-sonnet-5", agentNameOf: names }
    )
    expect(identity).toEqual({ lane: "agent", agentId: "kimi", agentName: "Kimi Code" })
    expect(sessionModelLabels(identity)).toEqual({ model: "Kimi Code", provider: "Kimi Code" })
  })

  it("names the agent's own model when the conversation picked one", () => {
    const identity = resolveSessionModelIdentity(
      session({
        externalAgentModels: { "claude-code": { kind: "native", modelId: "claude-sonnet-5" } },
      }),
      { sessionRuntimeRef: { kind: "external", agentId: "claude-code" }, agentNameOf: names }
    )
    expect(identity).toMatchObject({ lane: "agent", modelId: "claude-sonnet-5" })
    expect(identity).not.toHaveProperty("providerId")
    expect(sessionModelLabels(identity)).toEqual({
      model: "Claude Sonnet 5",
      provider: "Claude Code",
    })
  })

  it("names a Cognia model the agent runs through the gateway, with its provider", () => {
    const identity = resolveSessionModelIdentity(
      session({
        externalAgentModels: {
          kimi: { kind: "cognia", binding: { providerId: "openai", modelId: "gpt-5.6" } },
        },
      }),
      { sessionRuntimeRef: { kind: "external", agentId: "kimi" }, agentNameOf: names }
    )
    expect(identity).toMatchObject({ lane: "agent", modelId: "gpt-5.6", providerId: "openai" })
    expect(sessionModelLabels(identity).provider).not.toBe("Kimi Code")
  })

  it("never reads the built-in lane's model as an agent's", () => {
    // `session.model` without the agent's marker is a built-in pick left over
    // from an earlier turn. The agent runs its own default.
    const identity = resolveSessionModelIdentity(session({ model: "claude-opus-4-8" }), {
      sessionRuntimeRef: { kind: "external", agentId: "kimi" },
    })
    expect(identity).toEqual({ lane: "agent", agentId: "kimi" })
    // An agent this device has no name for says nothing rather than guessing.
    expect(sessionModelLabels(identity)).toEqual({})
  })

  it("uses a host-owned agent's name from the ref", () => {
    const identity = resolveSessionModelIdentity(session(), {
      sessionRuntimeRef: {
        kind: "host",
        configId: "cfg-1",
        revision: "r",
        lifecycleGeneration: 1,
        name: "Host Codex",
      },
    })
    expect(sessionModelLabels(identity)).toEqual({ model: "Host Codex", provider: "Host Codex" })
  })

  it("ignores a stale agent marker on a conversation this device runs built-in", () => {
    const identity = resolveSessionModelIdentity(
      session({ model: "kimi-k2", providerOverride: externalAgentProviderId("kimi") }),
      { sessionRuntimeRef: { kind: "builtin" }, defaultModel: "gpt-5.6", defaultProvider: "openai" }
    )
    expect(identity).toEqual({ lane: "builtin", modelId: "gpt-5.6", providerId: "openai" })
  })
})

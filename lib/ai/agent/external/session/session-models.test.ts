import type { AcpConfigOption, AcpSessionModelState } from "@/types/agent/external-agent"
import { gatewaySessionId } from "@/lib/ai/agent/external/config/gateway-task"

import {
  externalAgentIdFromProviderId,
  externalAgentProviderId,
  findModelConfigOption,
  isExternalAgentProviderId,
  resolveExternalAgentModelSelection,
  rememberGatewaySession,
  managedGatewayLinksOf,
  externalAgentRouteKey,
  sameCogniaModelBinding,
  cogniaGatewayGroupId,
  cogniaProviderIdFromGroupId,
  EXTERNAL_AGENT_GATEWAY_SESSIONS_PER_AGENT,
  resolveExternalAgentModels,
  reportableConfigOptions,
  seededModelSurface,
  EMPTY_THINKING_SURFACE,
  findThinkingConfigOption,
  resolveExternalAgentThinking,
} from "./session-models"

it("binds a persisted agent-model marker to one agent", () => {
  const marker = externalAgentProviderId("pi/one")
  expect(isExternalAgentProviderId(marker)).toBe(true)
  expect(externalAgentIdFromProviderId(marker)).toBe("pi/one")
  expect(externalAgentIdFromProviderId("cognia:external-agent")).toBeNull()
})

function modelOption(overrides: Partial<AcpConfigOption> = {}): AcpConfigOption {
  return {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: "anthropic/claude-sonnet-4-5",
    options: [
      { value: "anthropic/claude-sonnet-4-5", name: "Claude Sonnet 4.5" },
      { value: "openai/gpt-5", name: "GPT-5", description: "via OpenAI" },
    ],
    ...overrides,
  } as AcpConfigOption
}

const SESSION_MODELS: AcpSessionModelState = {
  availableModels: [
    { modelId: "acp-one", name: "ACP One" },
    { modelId: "acp-two", name: "ACP Two", description: "the other one" },
  ],
  currentModelId: "acp-two",
}

describe("resolveExternalAgentModels", () => {
  it("reads a config option and says the write goes through it", () => {
    const surface = resolveExternalAgentModels({ configOptions: [modelOption()] })
    expect(surface.choices).toEqual([
      { modelId: "anthropic/claude-sonnet-4-5", name: "Claude Sonnet 4.5" },
      { modelId: "openai/gpt-5", name: "GPT-5", description: "via OpenAI" },
    ])
    expect(surface.currentModelId).toBe("anthropic/claude-sonnet-4-5")
    expect(surface.write).toEqual({ kind: "config-option", optionId: "model" })
  })

  it("flattens grouped values, which is how Pi packs providers", () => {
    const grouped = modelOption({
      options: [
        { group: "anthropic", name: "Anthropic", options: [{ value: "a/one", name: "One" }] },
        { group: "openai", name: "OpenAI", options: [{ value: "o/two", name: "Two" }] },
      ],
    } as Partial<AcpConfigOption>)
    expect(resolveExternalAgentModels({ configOptions: [grouped] }).choices).toEqual([
      { modelId: "a/one", name: "One" },
      { modelId: "o/two", name: "Two" },
    ])
  })

  it("falls back to session model state when no config option declares models", () => {
    const surface = resolveExternalAgentModels({ sessionModels: SESSION_MODELS })
    expect(surface.choices.map((c) => c.modelId)).toEqual(["acp-one", "acp-two"])
    expect(surface.currentModelId).toBe("acp-two")
    expect(surface.write).toEqual({ kind: "session-model" })
  })

  it("prefers the config option when an agent offers both", () => {
    // The agent's own declared control wins, matching the precedence
    // `applyModelToSession` already used. Two writers disagreeing about which
    // call reaches the agent is how a picker changes nothing.
    const surface = resolveExternalAgentModels({
      configOptions: [modelOption()],
      sessionModels: SESSION_MODELS,
    })
    expect(surface.write).toEqual({ kind: "config-option", optionId: "model" })
    expect(surface.choices.map((c) => c.modelId)).toContain("openai/gpt-5")
  })

  it("keeps the current model when the agent lists none to switch to", () => {
    // A read-only answer. Dropping the current id would leave the picker
    // showing the wrong active row while the agent runs something else.
    const surface = resolveExternalAgentModels({
      configOptions: [modelOption({ options: [] } as Partial<AcpConfigOption>)],
    })
    expect(surface.choices).toEqual([])
    expect(surface.currentModelId).toBe("anthropic/claude-sonnet-4-5")
    expect(surface.write).toEqual({ kind: "none" })
  })

  it("answers empty for an agent with no model concept at all", () => {
    expect(resolveExternalAgentModels({})).toEqual({
      choices: [],
      currentModelId: null,
      write: { kind: "none" },
    })
    expect(resolveExternalAgentModels({ configOptions: [] })).toEqual({
      choices: [],
      currentModelId: null,
      write: { kind: "none" },
    })
  })

  it("ignores config options of every other category", () => {
    const mode = modelOption({ id: "mode", category: "mode" } as Partial<AcpConfigOption>)
    const thought = modelOption({
      id: "thought",
      category: "thought_level",
    } as Partial<AcpConfigOption>)
    expect(resolveExternalAgentModels({ configOptions: [mode, thought] }).choices).toEqual([])
  })

  it("falls back to the value id when the agent gives no display name", () => {
    const unnamed = modelOption({
      options: [{ value: "bare-id", name: "" }],
    } as Partial<AcpConfigOption>)
    expect(resolveExternalAgentModels({ configOptions: [unnamed] }).choices).toEqual([
      { modelId: "bare-id", name: "bare-id" },
    ])
  })
})

describe("findModelConfigOption", () => {
  it("returns undefined for a boolean option that happens to be categorised model", () => {
    // Only a select carries a list to choose from. A boolean in that category
    // is some other switch and must not be mistaken for the picker.
    const boolish = {
      id: "model",
      name: "Model",
      category: "model",
      type: "boolean",
      currentValue: true,
    } as AcpConfigOption
    expect(findModelConfigOption([boolish])).toBeUndefined()
  })
})

describe("resolveExternalAgentThinking", () => {
  const thinkingOption = (over: Partial<AcpConfigOption> = {}): AcpConfigOption =>
    ({
      id: "thinking",
      name: "Thinking",
      category: "thought_level",
      type: "select",
      currentValue: "medium",
      options: [
        { value: "off", name: "Off" },
        { value: "low", name: "Low" },
        { value: "medium", name: "Medium" },
        { value: "max", name: "Max" },
      ],
      ...over,
    }) as AcpConfigOption

  it("reads the agent's own vocabulary verbatim, in its own order", () => {
    // Not projected onto the app's tiers here. `off` has no EffortTier and
    // dropping it at this layer would hide from the caller that the agent
    // offers it, which is a different statement from the agent being silent.
    const surface = resolveExternalAgentThinking({ configOptions: [thinkingOption()] })
    expect(surface.levels).toEqual(["off", "low", "medium", "max"])
    expect(surface.currentLevel).toBe("medium")
    expect(surface.write).toEqual({ kind: "config-option", optionId: "thinking" })
  })

  it("answers the empty surface when the agent declares no thinking control", () => {
    // Absent, not broken: an agent with no depth axis still runs, and the
    // composer keeps offering its generic ladder for it.
    expect(resolveExternalAgentThinking({ configOptions: [] })).toEqual(EMPTY_THINKING_SURFACE)
    expect(resolveExternalAgentThinking({})).toEqual(EMPTY_THINKING_SURFACE)
  })

  it("keeps the current level but refuses the write when the list is empty", () => {
    // Same rule the model resolver keeps: dropping `currentLevel` would make
    // the control show the wrong active row, while a write has nowhere to go.
    const surface = resolveExternalAgentThinking({
      configOptions: [thinkingOption({ options: [] } as Partial<AcpConfigOption>)],
    })
    expect(surface.currentLevel).toBe("medium")
    expect(surface.write).toEqual({ kind: "none" })
  })

  it("does not mistake a model select for the thinking control", () => {
    const model = {
      id: "model",
      name: "Model",
      category: "model",
      type: "select",
      currentValue: "sonnet",
      options: [{ value: "sonnet", name: "Sonnet" }],
    } as AcpConfigOption
    expect(resolveExternalAgentThinking({ configOptions: [model] })).toEqual(EMPTY_THINKING_SURFACE)
  })
})

describe("findThinkingConfigOption", () => {
  it("ignores a boolean in the thought_level category", () => {
    // Only a select carries a ladder. A boolean there is some other switch.
    const boolish = {
      id: "thinking",
      name: "Thinking",
      category: "thought_level",
      type: "boolean",
      currentValue: true,
    } as AcpConfigOption
    expect(findThinkingConfigOption([boolish])).toBeUndefined()
  })
})

describe("resolveExternalAgentModelSelection", () => {
  const AGENT = "pi-local"
  const marker = externalAgentProviderId(AGENT)
  const kimi = { providerId: "plugin:kimi:subscription", modelId: "kimi-k3", accountId: "acc-a" }
  const claude = { providerId: "anthropic", modelId: "claude-opus-5" }
  const link = (task: string, binding?: typeof kimi | typeof claude) =>
    gatewaySessionId(task, `native-${task}`, binding)

  it("never reads the built-in lane's pick as a Cognia binding", () => {
    // A Claude pick left over from a built-in turn is what routed a Kimi turn
    // through the gateway on a phone and failed.
    const selection = resolveExternalAgentModelSelection({
      agentId: AGENT,
      session: { model: "claude-opus-5", providerOverride: "anthropic" },
    })
    expect(selection).toEqual({ cogniaModel: undefined, choice: null, source: "none" })
  })

  it("runs an explicit Cognia choice and starts a new task when none serves it", () => {
    const selection = resolveExternalAgentModelSelection({
      agentId: AGENT,
      session: {
        model: "claude-opus-5",
        providerOverride: "anthropic",
        externalAgentModels: { [AGENT]: { kind: "cognia", binding: kimi } },
      },
    })
    expect(selection).toMatchObject({
      cogniaModel: kimi,
      resetExternalSession: true,
      source: "conversation",
    })
    expect(selection.gatewayLink).toBeUndefined()
    expect(selection.model).toBeUndefined()
  })

  it("resumes the retained task whose binding equals the selection", () => {
    const kimiLink = link("task-kimi", kimi)
    const claudeLink = link("task-claude", claude)
    const selection = resolveExternalAgentModelSelection({
      agentId: AGENT,
      session: {
        externalAgentModels: { [AGENT]: { kind: "cognia", binding: kimi } },
        externalAgentSession: { agentId: AGENT, sessionId: claudeLink },
        externalAgentGatewaySessions: [
          { agentId: AGENT, sessionId: kimiLink },
          { agentId: "other", sessionId: link("task-other", kimi) },
          { agentId: AGENT, sessionId: claudeLink },
        ],
      },
    })
    expect(selection.gatewayLink).toBe(kimiLink)
    expect(selection.resetExternalSession).toBeUndefined()
  })

  it("rebinds the agent's latest task when switching Cognia models", () => {
    const kimiLink = link("task-kimi", kimi)
    const k3 = { ...kimi, modelId: "kimi-k3-256k" }
    const selection = resolveExternalAgentModelSelection({
      agentId: AGENT,
      session: {
        externalAgentModels: { [AGENT]: { kind: "cognia", binding: k3 } },
        externalAgentSession: { agentId: AGENT, sessionId: kimiLink },
      },
    })
    // The agent keeps its own history on the new model instead of a summary.
    expect(selection).toMatchObject({ cogniaModel: k3, gatewayLink: kimiLink, rebind: true })
    expect(selection.resetExternalSession).toBeUndefined()
  })

  it("starts a new task when the agent has no earlier Cognia task to rebind", () => {
    const selection = resolveExternalAgentModelSelection({
      agentId: AGENT,
      session: { externalAgentModels: { [AGENT]: { kind: "cognia", binding: claude } } },
    })
    expect(selection.rebind).toBeUndefined()
    expect(selection.gatewayLink).toBeUndefined()
    expect(selection.resetExternalSession).toBe(true)
  })

  it("rebinds rather than resumes a task bound to another subscription account", () => {
    const kimiLink = link("task-kimi", kimi)
    const selection = resolveExternalAgentModelSelection({
      agentId: AGENT,
      session: {
        externalAgentModels: {
          [AGENT]: { kind: "cognia", binding: { ...kimi, accountId: "acc-b" } },
        },
        externalAgentSession: { agentId: AGENT, sessionId: kimiLink },
      },
    })
    // Never resumed as-is on the old account: the manager rebinds it (same
    // owner, device and runtime) or refuses.
    expect(selection).toMatchObject({ gatewayLink: kimiLink, rebind: true })
    expect(selection.resetExternalSession).toBeUndefined()
  })

  it("accepts the frozen account when the selection leaves it to the provider default", () => {
    const kimiLink = link("task-kimi", kimi)
    const { accountId: _account, ...providerDefault } = kimi
    expect(
      resolveExternalAgentModelSelection({
        agentId: AGENT,
        session: {
          externalAgentModels: { [AGENT]: { kind: "cognia", binding: providerDefault } },
          externalAgentSession: { agentId: AGENT, sessionId: kimiLink },
        },
      }).gatewayLink
    ).toBe(kimiLink)
  })

  it("runs a native choice without any gateway link", () => {
    const selection = resolveExternalAgentModelSelection({
      agentId: AGENT,
      session: {
        externalAgentModels: { [AGENT]: { kind: "native", modelId: "a/one" } },
        externalAgentSession: { agentId: AGENT, sessionId: link("task-kimi", kimi) },
      },
      agentDefault: kimi,
    })
    expect(selection).toEqual({
      cogniaModel: null,
      model: "a/one",
      choice: { kind: "native", modelId: "a/one" },
      source: "conversation",
    })
  })

  it("keeps resuming a pre-existing gateway link when nothing was chosen", () => {
    const legacyLink = link("task-legacy")
    expect(
      resolveExternalAgentModelSelection({
        agentId: AGENT,
        session: { externalAgentSession: { agentId: AGENT, sessionId: legacyLink } },
      })
    ).toEqual({
      cogniaModel: undefined,
      gatewayLink: legacyLink,
      choice: null,
      source: "gateway-link",
    })
    const boundLink = link("task-kimi", kimi)
    expect(
      resolveExternalAgentModelSelection({
        agentId: AGENT,
        session: { externalAgentSession: { agentId: AGENT, sessionId: boundLink } },
      })
    ).toMatchObject({ cogniaModel: kimi, gatewayLink: boundLink, source: "gateway-link" })
  })

  it("ignores a malformed or foreign gateway link", () => {
    expect(
      resolveExternalAgentModelSelection({
        agentId: AGENT,
        session: { externalAgentSession: { agentId: AGENT, sessionId: "cognia-gateway:bad" } },
      }).source
    ).toBe("none")
    expect(
      resolveExternalAgentModelSelection({
        agentId: AGENT,
        session: { externalAgentSession: { agentId: "other", sessionId: link("t", kimi) } },
      }).source
    ).toBe("none")
  })

  it("replays the legacy marker as a native pick, from the row or the app default", () => {
    expect(
      resolveExternalAgentModelSelection({
        agentId: AGENT,
        session: { model: "commandcode/claude-opus-5", providerOverride: marker },
      })
    ).toMatchObject({
      cogniaModel: null,
      model: "commandcode/claude-opus-5",
      source: "legacy-marker",
    })
    expect(
      resolveExternalAgentModelSelection({
        agentId: AGENT,
        session: {},
        appDefaults: { defaultModel: "deepseek/v4", defaultProvider: marker },
      })
    ).toMatchObject({ cogniaModel: null, model: "deepseek/v4", source: "legacy-marker" })
  })

  it("never replays another agent's marker or the unscoped legacy marker", () => {
    for (const providerOverride of [externalAgentProviderId("codex"), "cognia:external-agent"]) {
      expect(
        resolveExternalAgentModelSelection({
          agentId: AGENT,
          session: { model: "a/one", providerOverride },
        }).source
      ).toBe("none")
    }
  })

  it("reads the welcome-screen default only when no conversation exists", () => {
    const appDefaults = {
      externalAgentModelDefaults: { [AGENT]: { kind: "cognia" as const, binding: claude } },
    }
    expect(
      resolveExternalAgentModelSelection({ agentId: AGENT, session: null, appDefaults })
    ).toMatchObject({ cogniaModel: claude, source: "app-default" })
    expect(
      resolveExternalAgentModelSelection({ agentId: AGENT, session: {}, appDefaults }).source
    ).toBe("none")
  })

  it("falls back to the agent configuration's default, then to native", () => {
    expect(
      resolveExternalAgentModelSelection({ agentId: AGENT, session: {}, agentDefault: kimi })
    ).toMatchObject({ cogniaModel: kimi, resetExternalSession: true, source: "agent-default" })
    expect(
      resolveExternalAgentModelSelection({ agentId: AGENT, session: {}, agentDefault: null })
    ).toMatchObject({ cogniaModel: null, source: "agent-default" })
  })
})

describe("gateway link bookkeeping", () => {
  const kimi = { providerId: "kimi", modelId: "k3" }
  const link = (agentId: string, task: string) => ({
    agentId,
    sessionId: gatewaySessionId(task, "native", kimi),
  })

  it("retains the replaced current link and bounds each agent's list", () => {
    let row: {
      externalAgentSession?: { agentId: string; sessionId: string }
      externalAgentGatewaySessions?: Array<{ agentId: string; sessionId: string }>
    } = { externalAgentSession: link("a", "t0") }
    const evicted: Array<{ agentId: string; sessionId: string }> = []
    for (let index = 1; index <= EXTERNAL_AGENT_GATEWAY_SESSIONS_PER_AGENT + 1; index += 1) {
      const next = link("a", `t${index}`)
      const result = rememberGatewaySession(row, next)
      evicted.push(...result.evicted)
      row = { externalAgentSession: next, externalAgentGatewaySessions: result.sessions }
    }
    expect(row.externalAgentGatewaySessions).toHaveLength(EXTERNAL_AGENT_GATEWAY_SESSIONS_PER_AGENT)
    expect(row.externalAgentGatewaySessions?.at(-1)).toEqual(row.externalAgentSession)
    expect(evicted).toEqual([link("a", "t0"), link("a", "t1")])
  })

  it("keeps another agent's links out of the bound and ignores native ids", () => {
    const result = rememberGatewaySession(
      {
        externalAgentSession: { agentId: "a", sessionId: "native-thread" },
        externalAgentGatewaySessions: [link("b", "tb")],
      },
      link("a", "ta")
    )
    expect(result).toEqual({ sessions: [link("b", "tb"), link("a", "ta")], evicted: [] })
  })

  it("lists every managed link a row holds, once", () => {
    expect(
      managedGatewayLinksOf({
        externalAgentSession: link("a", "t1"),
        externalAgentGatewaySessions: [
          link("a", "t0"),
          link("a", "t1"),
          { agentId: "a", sessionId: "x" },
        ],
      })
    ).toEqual([link("a", "t1"), link("a", "t0")])
    expect(managedGatewayLinksOf(undefined)).toEqual([])
  })

  it("names a route by its task, else by its binding", () => {
    expect(externalAgentRouteKey({ sessionId: gatewaySessionId("t9", "n", kimi) })).toBe(
      "cognia:t9"
    )
    expect(externalAgentRouteKey({ cogniaModel: { ...kimi, accountId: null } })).toBe(
      "cognia:kimi/k3/~manual"
    )
    expect(externalAgentRouteKey({ sessionId: "native", cogniaModel: null })).toBe("native")
  })

  it("compares bindings the way the manager resumes them", () => {
    expect(sameCogniaModelBinding(kimi, { ...kimi, accountId: "x" })).toBe(true)
    expect(sameCogniaModelBinding({ ...kimi, accountId: null }, { ...kimi, accountId: "x" })).toBe(
      false
    )
    expect(sameCogniaModelBinding(kimi, { ...kimi, modelId: "k2" })).toBe(false)
  })

  it("tells a picker's Cognia group apart from every other group", () => {
    const id = cogniaGatewayGroupId("plugin:kimi:subscription")
    expect(cogniaProviderIdFromGroupId(id)).toBe("plugin:kimi:subscription")
    expect(cogniaProviderIdFromGroupId(externalAgentProviderId("pi"))).toBeNull()
    expect(cogniaProviderIdFromGroupId("anthropic")).toBeNull()
  })
})

// What `kimi acp` (Kimi Code CLI 2.1.1) answers to `session/new`: no `models`
// field at all, a `model` and a `thought_level` select under `configOptions`.
const KIMI_SESSION_NEW_CONFIG_OPTIONS: AcpConfigOption[] = [
  {
    type: "select",
    id: "model",
    name: "Model",
    category: "model",
    currentValue: "kimi-code/kimi-for-coding",
    options: [
      { value: "kimi-code/kimi-for-coding", name: "K2.8 Preview" },
      { value: "kimi-code/kimi-for-coding-highspeed", name: "K2.7 Code Highspeed" },
      { value: "kimi-code/k3", name: "K3" },
      { value: "kimi-code/k3-256k", name: "K3-256k" },
    ],
  },
  {
    type: "select",
    id: "thinking",
    name: "Thinking",
    category: "thought_level",
    currentValue: "max",
    options: [
      { value: "low", name: "Thinking Low" },
      { value: "high", name: "Thinking High" },
      { value: "max", name: "Thinking Max" },
    ],
  },
  {
    type: "select",
    id: "mode",
    name: "Mode",
    category: "mode",
    currentValue: "default",
    options: [
      { value: "default", name: "Default" },
      { value: "plan", name: "Plan" },
    ],
  },
] as AcpConfigOption[]

describe("Kimi Code's session/new payload", () => {
  it("resolves to its own models, written through the `model` config option", () => {
    const surface = resolveExternalAgentModels({ configOptions: KIMI_SESSION_NEW_CONFIG_OPTIONS })
    expect(surface.choices.map((choice) => choice.name)).toEqual([
      "K2.8 Preview",
      "K2.7 Code Highspeed",
      "K3",
      "K3-256k",
    ])
    expect(surface.currentModelId).toBe("kimi-code/kimi-for-coding")
    expect(surface.write).toEqual({ kind: "config-option", optionId: "model" })
    expect(
      resolveExternalAgentThinking({ configOptions: KIMI_SESSION_NEW_CONFIG_OPTIONS })
    ).toEqual({
      levels: ["low", "high", "max"],
      currentLevel: "max",
      write: { kind: "config-option", optionId: "thinking" },
    })
  })
})

describe("seededModelSurface", () => {
  it("routes a pick through the next turn when there are models to pick", () => {
    const surface = resolveExternalAgentModels({ configOptions: KIMI_SESSION_NEW_CONFIG_OPTIONS })
    expect(seededModelSurface(surface)).toEqual({ ...surface, write: { kind: "session-seed" } })
  })

  it("offers no write when there is nothing to pick", () => {
    expect(
      seededModelSurface({ choices: [], currentModelId: "x", write: { kind: "none" } }).write
    ).toEqual({ kind: "none" })
  })
})

describe("reportableConfigOptions", () => {
  it("reports an agent's own option list verbatim", () => {
    const surfaces = {
      models: resolveExternalAgentModels({ configOptions: KIMI_SESSION_NEW_CONFIG_OPTIONS }),
      thinking: resolveExternalAgentThinking({ configOptions: KIMI_SESSION_NEW_CONFIG_OPTIONS }),
    }
    expect(reportableConfigOptions(KIMI_SESSION_NEW_CONFIG_OPTIONS, surfaces)).toEqual(
      KIMI_SESSION_NEW_CONFIG_OPTIONS
    )
  })

  it("folds session-model state and an async thinking ladder back into options", () => {
    const models = resolveExternalAgentModels({ sessionModels: SESSION_MODELS })
    const thinking = {
      levels: ["off", "high"],
      currentLevel: "high",
      write: { kind: "config-option" as const, optionId: "thinking_level" },
    }
    const reported = reportableConfigOptions(undefined, { models, thinking })
    // The receiving side derives the same surfaces back out of the report.
    expect(resolveExternalAgentModels({ configOptions: reported })).toEqual({
      ...models,
      write: { kind: "config-option", optionId: "model" },
    })
    expect(resolveExternalAgentThinking({ configOptions: reported })).toEqual(thinking)
  })

  it("carries model capabilities through the report", () => {
    const models = resolveExternalAgentModels({
      sessionModels: {
        currentModelId: "pi/one",
        availableModels: [
          {
            modelId: "pi/one",
            name: "One",
            capabilities: { contextWindow: 128_000, reasoning: true, vision: false },
          },
          { modelId: "pi/two", name: "Two" },
        ],
      },
    })
    expect(models.choices[0].capabilities).toEqual({
      contextWindow: 128_000,
      reasoning: true,
      vision: false,
    })
    expect(models.choices[1]).not.toHaveProperty("capabilities")
    const reported = reportableConfigOptions(undefined, {
      models,
      thinking: { levels: [], currentLevel: null, write: { kind: "none" } },
    })
    // A paired Host's report keeps them, so the client's picker draws them too.
    expect(resolveExternalAgentModels({ configOptions: reported }).choices).toEqual(models.choices)
  })

  it("reports nothing for an agent with no model or thinking concept", () => {
    expect(
      reportableConfigOptions(undefined, {
        models: { choices: [], currentModelId: null, write: { kind: "none" } },
        thinking: EMPTY_THINKING_SURFACE,
      })
    ).toEqual([])
  })
})

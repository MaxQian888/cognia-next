/**
 * The models an external agent will actually run, from whichever place it
 * keeps them.
 *
 * An agent can answer "which models do you have" in two unrelated shapes, and
 * a caller that only understands one sees an empty list from half the agents:
 *
 *   - **A config option** (`session/config_options`) whose category is
 *     `model`. This is where ACP puts it, and where Pi's RPC adapter projects
 *     its own `get_available_models` reply.
 *   - **Session model state** (`session/new`'s `models`, ACP's model
 *     selection). Older ACP agents populate this and no config option.
 *
 * Writing back has the same fork, and the SAME precedence: a config option is
 * the agent's own declared control, so it wins whenever one exists. That order
 * already lived inside `AgentManager.applyModelToSession`, which runs when a
 * session is created with a requested model. This module is where it became
 * reusable, so a picker and a session bootstrap cannot disagree about which
 * write reaches the agent.
 *
 * Everything here is pure. Nothing spawns, nothing awaits, and no verdict is
 * rendered about whether a model is any good: the caller decides what to do
 * with a list that comes back empty, which is a real answer meaning "this
 * agent does not offer a choice" rather than a failure.
 */

import type {
  AcpConfigOption,
  AcpConfigOptionValue,
  AcpSessionModelState,
} from "@/types/agent/external-agent"

/**
 * The provider id an external agent's own models are grouped under.
 *
 * Reserved rather than borrowed: it has to be distinguishable from every real
 * provider so a picker can route the write to the agent instead of to a
 * session override, and it must never collide with a `customProviders` entry.
 *
 * It lives here, beside the model vocabulary itself, rather than in the picker
 * that first needed it, because a session row stamped with it is read by the
 * SEND path too. A model chosen from an agent's list is that agent's word, not
 * a provider's, and the marker is the only thing that says so once the row has
 * been persisted.
 */
export const EXTERNAL_AGENT_PROVIDER_ID = "cognia:external-agent"

/** Persisted marker for a model chosen from one specific external agent. */
export function externalAgentProviderId(agentId: string): string {
  return `${EXTERNAL_AGENT_PROVIDER_ID}:${encodeURIComponent(agentId)}`
}

export function isExternalAgentProviderId(providerId: string | undefined): boolean {
  return (
    providerId === EXTERNAL_AGENT_PROVIDER_ID ||
    providerId?.startsWith(`${EXTERNAL_AGENT_PROVIDER_ID}:`) === true
  )
}

/** `null` also covers the legacy unscoped marker, which is unsafe to replay. */
export function externalAgentIdFromProviderId(providerId: string | undefined): string | null {
  const prefix = `${EXTERNAL_AGENT_PROVIDER_ID}:`
  if (!providerId?.startsWith(prefix)) return null
  try {
    return decodeURIComponent(providerId.slice(prefix.length)) || null
  } catch {
    return null
  }
}

/**
 * What an agent offers on its THINKING axis, plus how a choice reaches it.
 *
 * Separate from the model surface because the two answer different questions
 * and an agent can publish either without the other, but resolved from the SAME
 * `session/config_options` reply: ACP's `thought_level` category is where both
 * Pi (`get_available_thinking_levels`) and the Codex app-server client
 * (`supportedReasoningEfforts`) put theirs.
 *
 * `levels` is the agent's own vocabulary, verbatim and in its own order. It is
 * NOT the app's `EffortTier` union: Pi publishes `off` and `minimal` alongside
 * the tiers the app can persist, and folding here would hide from the caller
 * that the agent said so. `lib/ai/thinking-level.ts` does the projection.
 */
export interface ExternalAgentThinkingSurface {
  /** Read-only because {@link EMPTY_THINKING_SURFACE} is a frozen singleton. */
  levels: readonly string[]
  currentLevel: string | null
  /**
   * `config-option` carries the option id a write must name. `none` means the
   * agent published no thinking control, which a caller renders as absent
   * rather than as broken.
   */
  write: { kind: "config-option"; optionId: string } | { kind: "none" }
}

export const EMPTY_THINKING_SURFACE: ExternalAgentThinkingSurface = Object.freeze({
  levels: Object.freeze([]),
  currentLevel: null,
  write: Object.freeze({ kind: "none" }) as { kind: "none" },
})

/** The one select option an agent uses for thinking depth, if it declares one. */
export function findThinkingConfigOption(
  configOptions: readonly AcpConfigOption[] | undefined
): Extract<AcpConfigOption, { type: "select" }> | undefined {
  return configOptions?.find(
    (option): option is Extract<AcpConfigOption, { type: "select" }> =>
      option.category === "thought_level" && option.type === "select"
  )
}

/**
 * Resolve what a depth control should offer and where a selection should go.
 *
 * A declared-but-empty option still reports the agent's current level, for the
 * same reason the model resolver keeps one: dropping it would make the control
 * show the wrong active row.
 */
export function resolveExternalAgentThinking(input: {
  configOptions?: readonly AcpConfigOption[]
}): ExternalAgentThinkingSurface {
  const option = findThinkingConfigOption(input.configOptions)
  if (!option) return EMPTY_THINKING_SURFACE
  const values = flattenValues(option.options)
  return {
    levels: values.map((value) => value.value),
    currentLevel: option.currentValue || null,
    write: values.length > 0 ? { kind: "config-option", optionId: option.id } : { kind: "none" },
  }
}

/** One selectable model, flattened out of whichever shape carried it. */
export interface ExternalAgentModelChoice {
  modelId: string
  name: string
  description?: string
}

/** What an agent offers, plus how to write a choice back to it. */
export interface ExternalAgentModelSurface {
  choices: ExternalAgentModelChoice[]
  currentModelId: string | null
  /**
   * How a selection reaches the agent.
   *
   * - `config-option` carries the option id the write must name.
   * - `session-model` uses `session/set_model`.
   * - `session-seed` means the agent has no session open yet: the choice is
   *   recorded on the conversation and replayed by `applyModelToSession` when
   *   the agent opens one. Nothing is sent now, and nothing is broken.
   * - `none` means the agent offers models to READ but no way to change them,
   *   which a picker has to render as disabled rather than as broken.
   */
  write:
    | { kind: "config-option"; optionId: string }
    | { kind: "session-model" }
    | { kind: "session-seed" }
    | { kind: "none" }
}

const EMPTY: ExternalAgentModelSurface = Object.freeze({
  choices: Object.freeze([]) as unknown as ExternalAgentModelChoice[],
  currentModelId: null,
  write: Object.freeze({ kind: "none" }) as { kind: "none" },
})

/** The one select option an agent uses for models, if it declares one. */
export function findModelConfigOption(
  configOptions: readonly AcpConfigOption[] | undefined
): Extract<AcpConfigOption, { type: "select" }> | undefined {
  return configOptions?.find(
    (option): option is Extract<AcpConfigOption, { type: "select" }> =>
      option.category === "model" && option.type === "select"
  )
}

/** Flatten `AcpConfigOptionValue[] | AcpConfigOptionGroup[]` into plain values. */
function flattenValues(
  options: Extract<AcpConfigOption, { type: "select" }>["options"]
): AcpConfigOptionValue[] {
  return options.flatMap((entry) => ("group" in entry ? entry.options : [entry]))
}

/**
 * Resolve what a picker should show and where a selection should go.
 *
 * Both inputs are optional because an agent supplies one, the other, or
 * neither, and the caller does not know which until it has asked.
 */
export function resolveExternalAgentModels(input: {
  configOptions?: readonly AcpConfigOption[]
  sessionModels?: AcpSessionModelState | null
}): ExternalAgentModelSurface {
  const option = findModelConfigOption(input.configOptions)
  if (option) {
    const values = flattenValues(option.options)
    if (values.length > 0) {
      return {
        choices: values.map((value) => ({
          modelId: value.value,
          name: value.name || value.value,
          ...(value.description ? { description: value.description } : {}),
        })),
        currentModelId: option.currentValue || null,
        write: { kind: "config-option", optionId: option.id },
      }
    }
  }

  const available = input.sessionModels?.availableModels ?? []
  if (available.length > 0) {
    return {
      choices: available.map((model) => ({
        modelId: model.modelId,
        name: model.name || model.modelId,
        ...(model.description ? { description: model.description } : {}),
      })),
      currentModelId: input.sessionModels?.currentModelId || null,
      write: { kind: "session-model" },
    }
  }

  // A declared-but-empty option still tells us the agent's current model, and
  // dropping that would make the picker show the wrong active row.
  if (option?.currentValue) {
    return { choices: [], currentModelId: option.currentValue, write: { kind: "none" } }
  }
  const current = input.sessionModels?.currentModelId
  if (current) return { choices: [], currentModelId: current, write: { kind: "none" } }

  return EMPTY
}

/**
 * A session-less catalog (Pi's `--list-models`) as a surface.
 *
 * `currentModelId` is null on purpose: with no session open there is no
 * "current" model, and the picker falls back to the conversation's stored
 * choice, which is exactly what the agent will be asked to run.
 */
export function catalogModelSurface(
  models: ReadonlyArray<{ provider: string; id: string }>
): ExternalAgentModelSurface {
  if (models.length === 0) return EMPTY
  return {
    choices: models.map((model) => {
      const modelId = `${model.provider}/${model.id}`
      return { modelId, name: modelId }
    }),
    currentModelId: null,
    write: { kind: "session-seed" },
  }
}

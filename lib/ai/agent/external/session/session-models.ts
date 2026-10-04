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
  AppSettings,
  ChatSession,
  ExternalAgentModelChoice as ConversationModelChoice,
} from "@cognia/agent-config-types"
import type {
  AcpConfigOption,
  AcpConfigOptionValue,
  AcpSessionModelState,
  ExternalAgentCogniaModelBinding,
} from "@/types/agent/external-agent"
import { parseGatewaySessionId } from "@/lib/ai/agent/external/config/gateway-task"

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

/**
 * The group-id prefix the composer's picker gives a Cognia provider offered to
 * an external agent (`cognia:gateway:<providerId>`), so a selection from that
 * section is told apart from both an agent's own model and a built-in-lane
 * provider pick. A picker id only: never persisted, never a provider.
 */
export const COGNIA_GATEWAY_GROUP_PREFIX = "cognia:gateway:"

export function cogniaGatewayGroupId(providerId: string): string {
  return `${COGNIA_GATEWAY_GROUP_PREFIX}${encodeURIComponent(providerId)}`
}

/** The Cognia provider id a gateway group names, or `null` for any other group. */
export function cogniaProviderIdFromGroupId(groupId: string | undefined): string | null {
  if (!groupId?.startsWith(COGNIA_GATEWAY_GROUP_PREFIX)) return null
  try {
    return decodeURIComponent(groupId.slice(COGNIA_GATEWAY_GROUP_PREFIX.length)) || null
  } catch {
    return null
  }
}

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

/** How many retained gateway links a conversation keeps per agent. */
export const EXTERNAL_AGENT_GATEWAY_SESSIONS_PER_AGENT = 4

const GATEWAY_SESSION_PREFIX = "cognia-gateway:"

/** Whether a session id is a Cognia gateway task link (`gatewaySessionId`). */
export function isGatewaySessionLink(sessionId: string | undefined): sessionId is string {
  return sessionId?.startsWith(GATEWAY_SESSION_PREFIX) === true
}

/** A gateway link's parts, or `undefined` for a native id or a malformed link. */
function gatewayLinkParts(sessionId: string | undefined) {
  if (!isGatewaySessionLink(sessionId)) return undefined
  try {
    return parseGatewaySessionId(sessionId)
  } catch {
    // A link this build cannot read is evidence of nothing: it is neither
    // resumed nor allowed to decide the route.
    return undefined
  }
}

/**
 * Whether two bindings name the same gateway task route.
 *
 * Mirrors the manager's own resume check (`prepareGatewayExecution`): an
 * omitted account on the SELECTION accepts whatever account the task froze,
 * because "the provider default" was resolved once, at task start, and that
 * resolution is what the task is bound to. A concrete or `null` account must
 * match exactly.
 */
export function sameCogniaModelBinding(
  selection: ExternalAgentCogniaModelBinding,
  bound: ExternalAgentCogniaModelBinding
): boolean {
  return (
    selection.providerId === bound.providerId &&
    selection.modelId === bound.modelId &&
    (selection.accountId === undefined || selection.accountId === bound.accountId)
  )
}

/**
 * A stable key for a binding, for a run's route stamp when no task id is known.
 * The account is part of it: two accounts are two separate memories.
 */
export function cogniaModelBindingKey(binding: ExternalAgentCogniaModelBinding): string {
  // `null` (manual API settings) and omitted (provider default) are two routes.
  const account =
    binding.accountId === undefined
      ? ""
      : binding.accountId === null
        ? "~manual"
        : binding.accountId
  return [binding.providerId, binding.modelId, account].map(encodeURIComponent).join("/")
}

/**
 * The route a turn on an external agent ran (or will run) on, as transcript
 * memory: `native`, or `cognia:<taskId>` for a gateway task (falling back to
 * the binding's key when no task id is known yet).
 *
 * Finer than the lane: an agent's own native session and a gateway task on the
 * same agent keep two separate memories of the conversation, so a native
 * session resumed after Cognia turns must be told about those turns
 * (`lib/chat/turn-route/history.ts`).
 */
export function externalAgentRouteKey(input: {
  sessionId?: string
  cogniaModel?: ExternalAgentCogniaModelBinding | null
}): string {
  const link = gatewayLinkParts(input.sessionId)
  if (link) return `cognia:${link.taskId}`
  if (input.cogniaModel) return `cognia:${cogniaModelBindingKey(input.cogniaModel)}`
  return "native"
}

type GatewaySessionLink = { agentId: string; sessionId: string }

type SessionModelColumns = Pick<
  ChatSession,
  | "externalAgentModels"
  | "externalAgentSession"
  | "externalAgentGatewaySessions"
  | "model"
  | "providerOverride"
>

/**
 * Every gateway task link a conversation row still holds: the current slot and
 * the retained list, de-duplicated. What deleting the row must clean up.
 */
export function managedGatewayLinksOf(
  row: Pick<ChatSession, "externalAgentSession" | "externalAgentGatewaySessions"> | undefined
): GatewaySessionLink[] {
  const links = new Map<string, GatewaySessionLink>()
  for (const link of [row?.externalAgentSession, ...(row?.externalAgentGatewaySessions ?? [])]) {
    if (link && isGatewaySessionLink(link.sessionId))
      links.set(`${link.agentId}\u0000${link.sessionId}`, link)
  }
  return [...links.values()]
}

/**
 * The retained link list after `link` became the conversation's current one.
 *
 * The slot it replaces is kept too (a row written before the list existed has
 * its only link there), the newest goes last, and each agent keeps its last
 * {@link EXTERNAL_AGENT_GATEWAY_SESSIONS_PER_AGENT}. `evicted` is what fell off
 * the end, whose retained task state the caller should delete: nothing on the
 * row names it any more, so nothing else ever would.
 */
export function rememberGatewaySession(
  row: Pick<ChatSession, "externalAgentSession" | "externalAgentGatewaySessions"> | undefined,
  link: GatewaySessionLink
): { sessions: GatewaySessionLink[]; evicted: GatewaySessionLink[] } {
  const same = (a: GatewaySessionLink, b: GatewaySessionLink) =>
    a.agentId === b.agentId && a.sessionId === b.sessionId
  const ordered: GatewaySessionLink[] = []
  for (const candidate of [
    ...(row?.externalAgentGatewaySessions ?? []),
    row?.externalAgentSession,
    link,
  ]) {
    if (!candidate || !isGatewaySessionLink(candidate.sessionId)) continue
    const at = ordered.findIndex((entry) => same(entry, candidate))
    if (at >= 0) ordered.splice(at, 1)
    ordered.push({ agentId: candidate.agentId, sessionId: candidate.sessionId })
  }
  const kept: GatewaySessionLink[] = []
  const evicted: GatewaySessionLink[] = []
  const perAgent = new Map<string, number>()
  for (let index = ordered.length - 1; index >= 0; index -= 1) {
    const entry = ordered[index]
    const count = perAgent.get(entry.agentId) ?? 0
    if (count < EXTERNAL_AGENT_GATEWAY_SESSIONS_PER_AGENT) kept.unshift(entry)
    else evicted.push(entry)
    perAgent.set(entry.agentId, count + 1)
  }
  return { sessions: kept, evicted }
}

/** Where a turn's model selection came from, in precedence order. */
export type ExternalAgentModelSelectionSource =
  "conversation" | "gateway-link" | "legacy-marker" | "app-default" | "agent-default" | "none"

export interface ExternalAgentModelSelectionInput {
  /** The agent this turn runs on: a local agent id or a Host configuration id. */
  agentId: string
  /** The conversation row. `null`/`undefined` before one exists (the welcome screen). */
  session?: Partial<SessionModelColumns> | null
  /**
   * The agent configuration's own Cognia binding (`ExternalAgentConfig.cogniaModel`):
   * a binding, `null` for "explicitly native", `undefined` when this client
   * does not know it (a configuration the paired Host owns, whose default is
   * the Host's to apply).
   */
  agentDefault?: ExternalAgentCogniaModelBinding | null
  /**
   * App-wide fallbacks. `externalAgentModelDefaults` is read only when there
   * is no conversation row: `createSession` copies it onto the row, after
   * which the choice is the conversation's own. The legacy app-default marker
   * (`defaultProvider` naming this agent) is still honoured as a native pick.
   */
  appDefaults?: Partial<
    Pick<AppSettings, "externalAgentModelDefaults" | "defaultModel" | "defaultProvider">
  > | null
}

export interface ExternalAgentModelSelection {
  /**
   * A binding runs the turn through the Cognia gateway; `null` runs the
   * agent's own models; `undefined` leaves it to the agent configuration's
   * default (on a Host lane, the Host's).
   */
  cogniaModel: ExternalAgentCogniaModelBinding | null | undefined
  /** The agent's own model id to replay. Only ever set on the native route. */
  model?: string
  /**
   * The gateway task link to resume: set only when a link's binding EQUALS
   * the selection (or, with no explicit choice, the conversation's current
   * link, which is its own evidence of the route).
   */
  gatewayLink?: string
  /**
   * The selection is a Cognia binding that no retained task serves, so the
   * turn starts a new task and must not resume whatever the conversation last
   * had open on this agent. The caller hands the transcript over.
   */
  resetExternalSession?: boolean
  /**
   * Switching between Cognia models: `gatewayLink` is this agent's most recent
   * task, bound to ANOTHER Cognia model, and the manager may
   * rebind it to the selection so the agent keeps its own history instead of
   * getting a summary. Only a local lane can rebind; a Host lane treats this
   * as a reset.
   */
  rebind?: boolean
  /** The choice the picker should show as active, or `null` for the agent's own default. */
  choice: ConversationModelChoice | null
  source: ExternalAgentModelSelectionSource
}

/**
 * Which models a turn on THIS agent runs, read from the places the choice can
 * have been recorded, in precedence order:
 *
 * 1. the conversation's explicit choice, `session.externalAgentModels[agentId]`;
 * 2. for rows written before that existed, the conversation's current
 *    `cognia-gateway:` link for this agent (its encoded binding, if any);
 * 3. the legacy `cognia:external-agent:<id>` marker, on the row or the app
 *    default, as a native pick of that model;
 * 4. with no row yet, `AppSettings.externalAgentModelDefaults[agentId]`;
 * 5. the agent configuration's default binding;
 * 6. native, on the agent's own default model.
 *
 * It never reads `session.model` / `providerOverride` / `accountId` as a
 * binding. Those are the built-in lane's pick, and treating them as a Cognia
 * selection is what routed a Kimi turn through a Claude model left over from
 * a built-in turn.
 */
export function resolveExternalAgentModelSelection(
  input: ExternalAgentModelSelectionInput
): ExternalAgentModelSelection {
  const { agentId, session } = input
  const currentLink =
    session?.externalAgentSession?.agentId === agentId &&
    isGatewaySessionLink(session.externalAgentSession.sessionId)
      ? session.externalAgentSession.sessionId
      : undefined

  const explicit = session?.externalAgentModels?.[agentId]
  if (explicit) return fromChoice(explicit, "conversation")

  if (currentLink) {
    const parts = gatewayLinkParts(currentLink)
    if (parts) {
      return {
        cogniaModel: parts.binding,
        gatewayLink: currentLink,
        choice: parts.binding ? { kind: "cognia", binding: parts.binding } : null,
        source: "gateway-link",
      }
    }
  }

  const marked = (model: string | undefined, providerId: string | undefined) =>
    model?.trim() && externalAgentIdFromProviderId(providerId) === agentId
      ? model.trim()
      : undefined
  const legacy =
    marked(session?.model, session?.providerOverride) ??
    marked(input.appDefaults?.defaultModel, input.appDefaults?.defaultProvider)
  if (legacy) return fromChoice({ kind: "native", modelId: legacy }, "legacy-marker")

  if (!session) {
    const appDefault = input.appDefaults?.externalAgentModelDefaults?.[agentId]
    if (appDefault) return fromChoice(appDefault, "app-default")
  }

  if (input.agentDefault) {
    return fromChoice({ kind: "cognia", binding: input.agentDefault }, "agent-default")
  }
  if (input.agentDefault === null) return fromChoice({ kind: "native" }, "agent-default")
  return { cogniaModel: undefined, choice: null, source: "none" }

  function fromChoice(
    choice: ConversationModelChoice,
    source: ExternalAgentModelSelectionSource
  ): ExternalAgentModelSelection {
    if (choice.kind === "native") {
      return {
        cogniaModel: null,
        ...(choice.modelId ? { model: choice.modelId } : {}),
        choice,
        source,
      }
    }
    const binding = choice.binding
    const candidates = [
      ...(currentLink ? [currentLink] : []),
      ...[...(session?.externalAgentGatewaySessions ?? [])]
        .reverse()
        .filter((link) => link.agentId === agentId)
        .map((link) => link.sessionId),
    ]
    const gatewayLink = candidates.find((sessionId) => {
      const bound = gatewayLinkParts(sessionId)?.binding
      return bound !== undefined && sameCogniaModelBinding(binding, bound)
    })
    if (gatewayLink) return { cogniaModel: binding, gatewayLink, choice, source }
    // No task runs this model yet. The agent's latest task can be rebound to
    // it, provider, model and subscription account included: the links are
    // this conversation's, for this agent, on this client, and the manager
    // enforces the rest (same Cognia owner, device and runtime).
    const latest = candidates[0]
    if (latest && gatewayLinkParts(latest)?.binding) {
      return { cogniaModel: binding, gatewayLink: latest, rebind: true, choice, source }
    }
    return { cogniaModel: binding, resetExternalSession: true, choice, source }
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
export function flattenValues(
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
 * A surface whose writes cannot reach the agent's session directly, so a pick
 * is recorded on the conversation and replayed by `applyModelToSession` on the
 * next turn.
 *
 * Used for what a paired Host REPORTED about the session it runs: this client
 * holds no handle on that session, but the Host applies the persisted model at
 * the start of the next turn (`startRemoteExternalTurn({ model })`).
 */
export function seededModelSurface(surface: ExternalAgentModelSurface): ExternalAgentModelSurface {
  return {
    ...surface,
    write: surface.choices.length > 0 ? { kind: "session-seed" } : { kind: "none" },
  }
}

/**
 * The model and thinking options a session should report, as config options.
 *
 * The agent's own option list is reported verbatim when it has one, because
 * that is the shape ACP clients already understand. An agent that keeps its
 * models elsewhere (ACP `session/new` → `models`, or an adapter that answers
 * asynchronously) has its resolved surfaces folded back into the matching
 * `select` options, so the receiving side re-derives the same surfaces with
 * {@link resolveExternalAgentModels} and {@link resolveExternalAgentThinking}.
 */
export function reportableConfigOptions(
  configOptions: readonly AcpConfigOption[] | undefined,
  surfaces: { models: ExternalAgentModelSurface; thinking: ExternalAgentThinkingSurface }
): AcpConfigOption[] {
  const options = [...(configOptions ?? [])]
  const { models, thinking } = surfaces
  if (!findModelConfigOption(options) && models.choices.length > 0) {
    options.push({
      id: models.write.kind === "config-option" ? models.write.optionId : "model",
      name: "Model",
      category: "model",
      type: "select",
      currentValue: models.currentModelId ?? "",
      options: models.choices.map((choice) => ({
        value: choice.modelId,
        name: choice.name,
        ...(choice.description ? { description: choice.description } : {}),
      })),
    })
  }
  if (!findThinkingConfigOption(options) && thinking.levels.length > 0) {
    options.push({
      id: thinking.write.kind === "config-option" ? thinking.write.optionId : "thought_level",
      name: "Thinking",
      category: "thought_level",
      type: "select",
      currentValue: thinking.currentLevel ?? "",
      options: thinking.levels.map((level) => ({ value: level, name: level })),
    })
  }
  return options
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

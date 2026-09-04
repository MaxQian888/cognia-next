/**
 * A Bot is a binding, not an engine.
 *
 * Everything a Bot does at runtime is already owned by something else. It runs
 * on the Workflow orchestrator, a Squad, a plain agent turn or a plugin
 * handler. Its journal is an `ExecutionRun`. Its human decisions are
 * `ExecutionRunInterrupt` rows on the shared decision surface. Its writes to
 * the outside world go through the Integration action broker, which already
 * owns approval, idempotency, backoff, dead-lettering, the PII gate and the
 * origin allowlist.
 *
 * What a Bot definition adds is the part nothing owned before: one named,
 * versioned, installable unit that binds an event source to a policy to an
 * executor to a set of credentials, so a user can install it and an author can
 * ship it.
 *
 * ## Why this is a manifest array
 *
 * A Bot cannot be registered by handing the host a callback. The Python
 * runtime refuses every API method whose `resourceEffect` is
 * `returned-disposer`, because neither a callback nor its disposer survives
 * the stdio boundary (ADR-0145). A `ctx.bots.registerHandler(fn)` would
 * therefore exist for TypeScript authors and not for Python ones, which is
 * exactly the split ADR-0155 exists to prevent. So a Bot is declared, and only
 * its `handler` executor names a module the host resolves itself.
 */

import type {
  AgentAuthority,
  AutonomyLevel,
  EngagementMode,
} from "@cognia/agent-config-types/agent-composition"

import type { PluginIconName } from "./plugin-icon"

/**
 * Where an event a Bot listens for comes from.
 *
 * Each member names a producer that ALREADY persists, deduplicates and
 * recovers its own inbound work. The Bot event plane routes and fans out, it
 * does not become a second inbox.
 */
export type PluginBotEventSource =
  /** `publishIntegrationEvent`, including every verified inbound webhook. */
  | "integration"
  /** A workflow reaching a terminal state. */
  | "workflow"
  /** ConnectorBus inbound, after the connector's own trigger policy passed. */
  | "connector"
  /** Desktop and pet event triggers. */
  | "desktop"
  /** Another Bot run. Ignored unless the installation opts in explicitly. */
  | "bot"

interface PluginBotTriggerBase {
  id: string
  /** Author-facing label. User-facing text is resolved from `labelKey`. */
  label?: string
  labelKey?: string
  /**
   * Whether an installation starts with this trigger armed. A trigger that
   * writes to the outside world should ship `false` and be armed on purpose.
   */
  enabledByDefault?: boolean
  /**
   * Serialisation key, interpolated against the event envelope (for example
   * `"{{resource.id}}"`). Two deliveries with the same key never run at once,
   * which is what stops two pushes racing on one branch.
   */
  concurrencyKey?: string
  /** Hold a delivery this long, so a burst of edits becomes one run. */
  debounceMs?: number
  /**
   * What to do with deliveries that arrived during `debounceMs`. `latest`
   * drops the earlier ones, `all` hands the handler every envelope.
   */
  coalesce?: "latest" | "all"
}

/** A human addressed the Bot in a conversation it is bound to. */
export interface PluginBotInteractionTrigger extends PluginBotTriggerBase {
  kind: "interaction"
  /**
   * Connector adapter types this trigger accepts. Absent means "whatever the
   * installation bound", which is the common case.
   */
  adapterTypes?: string[]
}

/** An external or internal event matched by source and type. */
export interface PluginBotEventTrigger extends PluginBotTriggerBase {
  kind: "event"
  source: PluginBotEventSource
  /** Event type names, for example `["pull_request.opened"]`. */
  types: string[]
}

/** A cron schedule, run by the scheduler on whichever Host owns the task. */
export interface PluginBotScheduleTrigger extends PluginBotTriggerBase {
  kind: "schedule"
  cron: string
  timezone?: string
}

/**
 * The Bot asks a remote for what changed since its last cursor. The host
 * stores the cursor per installation, the handler decides what it means.
 */
export interface PluginBotPollTrigger extends PluginBotTriggerBase {
  kind: "poll"
  everyMs: number
  /** Cursor name, so one Bot can keep several independent cursors. */
  cursor?: string
}

/**
 * The Bot watches a predicate over state it can already read, and acts when
 * the answer CHANGES. An SLA breach and a stale pull request are this shape.
 *
 * The host cannot evaluate a predicate it does not own, so the division is
 * explicit: the host CARRIES the last answer across evaluations and hands it
 * to the handler in the event payload, and the handler reports the new one in
 * its result. That is what lets the handler tell a change from a state instead
 * of notifying on every tick, which is how a derived state becomes a
 * notification loop.
 *
 * `edge` defaults to `rising`. A level trigger is deliberately not offered.
 */
export interface PluginBotDerivedStateTrigger extends PluginBotTriggerBase {
  kind: "derivedState"
  everyMs: number
  /** Name of the state the handler evaluates. */
  state: string
  edge?: "rising" | "falling" | "both"
}

/** A person pressed Run. Always available, declared so it can be labelled. */
export interface PluginBotManualTrigger extends PluginBotTriggerBase {
  kind: "manual"
}

export type PluginBotTriggerDef =
  | PluginBotInteractionTrigger
  | PluginBotEventTrigger
  | PluginBotScheduleTrigger
  | PluginBotPollTrigger
  | PluginBotDerivedStateTrigger
  | PluginBotManualTrigger

/**
 * A credential the Bot needs, named logically. The definition never carries a
 * secret or an account id. Installation binds the slot to a real integration
 * account, and the broker resolves the credential without the handler seeing
 * it.
 */
export interface PluginBotCredentialSlot {
  id: string
  label: string
  /** Integration the account must belong to, for example `github-delivery`. */
  integration?: string
  /** Auth strategy id inside that integration, for example `github-app`. */
  strategy?: string
  optional?: boolean
}

export interface PluginBotRequirementsV1 {
  credentials?: PluginBotCredentialSlot[]
  /**
   * Brokered actions this Bot may execute, as `<integrationId>.<actionId>`.
   * An allowlist, not a grant: the broker still applies risk, approval and
   * the account's own scopes to every call.
   */
  integrationActions?: string[]
  /**
   * Host features without which the Bot cannot run, for example
   * `integrations.ingress`. Used by placement to refuse a Host rather than
   * to run the Bot in a degraded shape.
   */
  hostFeatures?: string[]
}

/**
 * The posture the Bot asks for. Every field is a REQUEST that resolution
 * narrows. Orchestration is absent on purpose: it is derived from the
 * executor, so the two can never disagree.
 */
export interface PluginBotCompositionRequestV1 {
  presetId?: string
  authority?: AgentAuthority
  engagement?: EngagementMode
  autonomy?: AutonomyLevel
}

/**
 * The Bot's own ceiling. Every value here is intersected with the
 * organisation policy, the plugin's granted permissions, the installation's
 * grant and the individual run request. A lower layer can only narrow.
 */
export interface PluginBotPolicyV1 {
  maxAuthority?: AgentAuthority
  maxAutonomy?: AutonomyLevel
  /**
   * Require a human decision for every brokered write, including ones the
   * broker would have classified as low risk.
   */
  requireApprovalForWrites?: boolean
  /** Wall-clock ceiling for one run. */
  maxRunDurationMs?: number
  /** Cost ceiling for one run, handed to the run budget governor. */
  maxRunCostUsd?: number
  /** Runs allowed in flight for one installation. */
  maxConcurrentRuns?: number
  /**
   * Accept events this Bot's own runs produced. Off by default, because a Bot
   * that comments on a pull request and listens for comments is a loop.
   */
  allowSelfTriggering?: boolean
}

interface PluginBotDefBase {
  id: string
  name: string
  description?: string
  /**
   * Semantic version of the DEFINITION, independent of the plugin's version.
   * An installation pins one, so shipping a new plugin build does not silently
   * change what an armed Bot does.
   */
  version: string
  icon?: PluginIconName
  /**
   * Persona the Bot speaks as, a character id or a `cognia-pack:` id from this
   * plugin's own character pack. Absent means the installation chooses.
   */
  character?: string
  composition?: PluginBotCompositionRequestV1
  /** At least one trigger, or the Bot can never start. */
  triggers: PluginBotTriggerDef[]
  requires?: PluginBotRequirementsV1
  policy?: PluginBotPolicyV1
  /** JSON Schema for the per-installation configuration form. */
  configSchema?: Record<string, unknown>
}

/**
 * Runs a published workflow deployment. The deployment is resolved through
 * `execution-authority`, so the Bot runs an immutable artifact with its
 * dependencies locked, not whatever the editor last saved.
 */
export interface PluginWorkflowBotDef extends PluginBotDefBase {
  executor: "workflow"
  /** Workflow id owned by this plugin, or a published deployment ref. */
  workflow: string
  team?: never
  prompt?: never
  entry?: never
  export?: never
  backend?: never
}

/** Runs a Squad. */
export interface PluginSquadBotDef extends PluginBotDefBase {
  executor: "squad"
  team: string
  workflow?: never
  prompt?: never
  entry?: never
  export?: never
  backend?: never
}

/**
 * Runs one bounded agent turn. The prompt is a template interpolated against
 * the event envelope and the installation config.
 */
export interface PluginAgentTurnBotDef extends PluginBotDefBase {
  executor: "agent-turn"
  prompt: string
  workflow?: never
  team?: never
  entry?: never
  export?: never
  backend?: never
}

/**
 * Runs a durable handler the plugin ships.
 *
 * `entry` is a module path, resolved the way every other contributed entry is.
 * A Python plugin leaves it absent (or sets `backend: "python"`) and the host
 * dispatches through the python-backed contribution seam instead.
 *
 * The handler is re-entered from the top after a crash. Work it must not
 * repeat belongs inside a step, which is memoized on the run's event journal.
 */
export interface PluginHandlerBotDef extends PluginBotDefBase {
  executor: "handler"
  entry?: string
  /** Named export of `entry`. Defaults to `default`. */
  export?: string
  /** Force a backend rather than inferring it from `entry` and plugin type. */
  backend?: "js" | "python"
  workflow?: never
  team?: never
  prompt?: never
}

export type PluginBotDef =
  PluginWorkflowBotDef | PluginSquadBotDef | PluginAgentTurnBotDef | PluginHandlerBotDef

/** The executor discriminants, as a runtime list for validators and pickers. */
export const PLUGIN_BOT_EXECUTORS = ["workflow", "squad", "agent-turn", "handler"] as const
export type PluginBotExecutor = (typeof PLUGIN_BOT_EXECUTORS)[number]

/** The trigger discriminants, as a runtime list for validators and pickers. */
export const PLUGIN_BOT_TRIGGER_KINDS = [
  "interaction",
  "event",
  "schedule",
  "poll",
  "derivedState",
  "manual",
] as const
export type PluginBotTriggerKind = (typeof PLUGIN_BOT_TRIGGER_KINDS)[number]

/**
 * The executor-specific field each discriminant requires. `handler` maps to
 * `null` because a Python-backed handler declares no `entry`: the host
 * dispatches into the plugin process instead.
 */
export const PLUGIN_BOT_EXECUTOR_REQUIRED_FIELD: Readonly<
  Record<PluginBotExecutor, "workflow" | "team" | "prompt" | null>
> = {
  workflow: "workflow",
  squad: "team",
  "agent-turn": "prompt",
  handler: null,
}

/** Every executor-target field, so a validator can refuse the ones that do not belong. */
export const PLUGIN_BOT_EXECUTOR_FIELDS = ["workflow", "team", "prompt"] as const

export const PLUGIN_BOT_EVENT_SOURCES = [
  "integration",
  "workflow",
  "connector",
  "desktop",
  "bot",
] as const

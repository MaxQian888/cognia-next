/**
 * Row shapes for the Bot control plane.
 *
 * Three tables, and the count is deliberate.
 *
 * `botDefinitions` holds what a person authored in Creator. A plugin's
 * definitions are NOT here: they are registry overlays that come and go with
 * the plugin, and copying them into a table would create a second, stale
 * answer to "what does this Bot do".
 *
 * `botInstallations` is the row that says "this Bot, here, as this identity,
 * with these credentials, under this ceiling". It is the Bot analogue of a
 * connector's `AdapterInstanceRow`.
 *
 * `botEventDeliveries` is the per-recipient fan-out unit. There is no
 * `botEvents` table on purpose: every source already persists, deduplicates
 * and recovers its own inbound work (`connectorInboundJobs`,
 * `integrationEvents`, the scheduler), and a second event log would be a
 * second thing to keep true. What the Bot plane owns is the delivery, because
 * retry, dead-lettering and replay are per installation, not per event.
 */

import type { BotEventEnvelopeV1, BotEventSource } from "@/types/bot/event"
import type {
  PluginBotCompositionRequestV1,
  PluginBotExecutor,
  PluginBotPolicyV1,
  PluginBotRequirementsV1,
  PluginBotTriggerDef,
} from "@/types/plugin/plugin-bot"

/** Where a definition an installation points at lives. */
export type BotDefinitionSource = "plugin" | "local"

/**
 * A Creator-authored Bot definition.
 *
 * `executor: "handler"` is absent from the union a local definition may use:
 * a handler is a module, and a row has no module to load. A person who wants
 * custom code writes a plugin.
 */
export type LocalBotExecutor = Exclude<PluginBotExecutor, "handler">

export interface BotDefinitionRow {
  id: string
  name: string
  description?: string
  /** Semantic version. An installation pins one. */
  version: string
  icon?: string
  character?: string
  composition?: PluginBotCompositionRequestV1
  executor: LocalBotExecutor
  /** Present for `executor: "workflow"`. */
  workflow?: string
  /** Present for `executor: "squad"`. */
  team?: string
  /** Present for `executor: "agent-turn"`. */
  prompt?: string
  triggers: PluginBotTriggerDef[]
  requires?: PluginBotRequirementsV1
  policy?: PluginBotPolicyV1
  configSchema?: Record<string, unknown>
  /** Owning workspace. Absent means the definition is account-wide. */
  workspaceId?: string
  createdAt: number
  updatedAt: number
}

export type BotScopeKind = "account" | "workspace" | "project"

export interface BotInstallationScope {
  kind: BotScopeKind
  workspaceId?: string
  projectId?: string
}

/**
 * What a credential slot resolves to. Never a secret: the ids point at an
 * integration account and its auth session, and the broker resolves the actual
 * credential without the Bot or its handler ever seeing it.
 */
export interface BotCredentialBinding {
  integrationAccountId?: string
  authSessionId?: string
  /**
   * Connector adapter instance, for a slot that binds an IM account rather
   * than an integration one. A slot is bound when it names ANY of the three,
   * because which one it needs is the integration's business, not this table's.
   */
  adapterId?: string
}

/**
 * Per-trigger runtime state, kept on the installation rather than in a table
 * of its own.
 *
 * Cursors and watermarks are written once per poll, and a Bot has a handful of
 * triggers, so the write volume is nowhere near a hot path. If it ever becomes
 * one, this is the field to promote to its own table.
 */
export interface BotTriggerRuntimeState {
  /** Opaque poll cursor. The host stores it, the handler decides what it means. */
  cursor?: string
  /** Highest point a `derivedState` trigger has already fired past. */
  watermark?: number
  /**
   * Last evaluated predicate value, so an edge trigger can tell a change from
   * a state. Without it, `derivedState` degenerates into firing every tick.
   */
  lastEdgeValue?: boolean
  lastFiredAt?: number
  /** Deliveries are held until this instant by the trigger's `debounceMs`. */
  debounceUntil?: number
}

/**
 * An installation's state.
 *
 * `needs_setup` is a real third answer, not a flavour of disabled: the
 * installation exists and is wanted, but a required credential slot is
 * unbound, so arming it would fail at the first external call. Collapsing it
 * into `disabled` would leave a user with no way to tell "I turned this off"
 * from "this is one binding away from working".
 */
export type BotInstallationStatus = "enabled" | "disabled" | "needs_setup"

export interface BotInstallationRow {
  id: string
  /** Namespaced plugin id (`<pluginId>:<botId>`) or a `botDefinitions` id. */
  definitionId: string
  definitionSource: BotDefinitionSource
  /** The definition version this installation runs, pinned at install time. */
  pinnedVersion: string
  scope: BotInstallationScope
  /** Denormalized from `scope` so the index can answer per-workspace queries. */
  workspaceId?: string
  projectId?: string
  status: BotInstallationStatus
  /** Per-installation configuration, validated against the definition's schema. */
  config: Record<string, unknown>
  /** Slot id to binding. A slot the definition requires and this map lacks is what makes an installation `needs_setup`. */
  credentialBindings: Record<string, BotCredentialBinding>
  /** Trigger id to armed. A trigger absent here uses the definition's default. */
  triggerOverrides?: Record<string, boolean>
  triggerState?: Record<string, BotTriggerRuntimeState>
  /**
   * The ceiling this installation grants. Intersected with the organisation
   * policy, the plugin's permissions, the definition's own policy and the run
   * request, so it can only ever narrow what is already allowed.
   */
  policyGrant?: PluginBotPolicyV1
  /** Host reference this installation prefers. Absent means `auto`. */
  placementRef?: string
  createdAt: number
  updatedAt: number
}

/**
 * Delivery lifecycle.
 *
 * `failed` is retryable and returns to `pending` after backoff. `deadletter`
 * is terminal and replayable by hand. `dismissed` is a delivery that was
 * correctly never run, because coalescing superseded it or its installation
 * was disabled while it waited, and it is kept apart from `failed` so a
 * quiet queue does not read as a broken one.
 */
export type BotDeliveryStatus =
  "pending" | "leased" | "running" | "succeeded" | "failed" | "deadletter" | "dismissed"

export interface BotEventDeliveryRow {
  /** The delivery id. Also `envelope.deliveryId`. */
  id: string
  eventId: string
  installationId: string
  triggerId: string
  source: BotEventSource
  type: string
  /**
   * Arrival-dedup key, unique across the table. Two deliveries of the same
   * source event to the same installation collapse onto one row, which is what
   * makes an at-least-once source safe to fan out from.
   */
  dedupKey: string
  status: BotDeliveryStatus
  attempts: number
  nextAttemptAt: number
  leaseOwner?: string
  leaseExpiresAt?: number
  /**
   * Serialisation key from the trigger, interpolated against the envelope. At
   * most one delivery per key runs at a time, which is what stops two pushes
   * racing on one branch.
   */
  concurrencyKey?: string
  /** Correlation key a run parked in `waitForEvent` matches on. */
  correlation?: string
  /** Held until this instant by the trigger's debounce. */
  notBefore?: number
  /** The full envelope, so a delivery is independently replayable. */
  envelope: BotEventEnvelopeV1
  /** The ExecutionRun this delivery started, once it has one. */
  runId?: string
  lastError?: string
  receivedAt: number
  updatedAt: number
  /** When the delivery reached a terminal status. Drives retention. */
  settledAt?: number
}

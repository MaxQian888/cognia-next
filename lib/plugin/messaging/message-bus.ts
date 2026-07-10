/**
 * Plugin Message Bus
 *
 * Global event bus for cross-plugin and system-wide events.
 * Provides typed event handling with namespacing and filtering.
 */

import { loggers } from "../core/logger"
import { pluginHasApiPermission } from "@/lib/plugin/api/permission-api"
import { PLUGIN_MESSAGE_HISTORY_MAX, PLUGIN_MESSAGE_MAX_BYTES } from "./constants"
import type {
  BusEvent,
  EventSource,
  EventFilter,
  PluginEventAPI,
} from "@/types/plugin/plugin-messaging"

// Re-export the messaging type contracts (single source of truth in `types/`).
export type { BusEvent, EventSource, EventFilter, PluginEventAPI }

// =============================================================================
// Types
// =============================================================================

export interface EventSubscription {
  id: string
  eventType: string | RegExp
  handler: (event: BusEvent) => void
  source: EventSource
  filter?: EventFilter
  priority: number
  once: boolean
}

export interface MessageBusConfig {
  maxHistory: number
  enableLogging: boolean
  enableReplay: boolean
  replayWindow: number
}

type EventHandler<T = unknown> = (event: BusEvent<T>) => void

/**
 * The `system:` topic prefix is reserved for host-published events
 * ({@link MessageBus.emitFromSystem}). A plugin emitting under it would be
 * able to forge trustworthy-looking lifecycle signals (e.g.
 * `system:agent:completed`) since subscribers key on the event type, not the
 * source. {@link MessageBus.emit} rejects plugin-sourced `system:*` emits so a
 * `system:*` event provably came from the host.
 */
export const RESERVED_EVENT_NAMESPACE = "system:"

/**
 * Thrown when a plugin tries to publish under the reserved `system:` namespace.
 * Mirrors the IPC layer's typed errors so callers can pattern-match by `name`.
 */
export class BusNamespaceError extends Error {
  constructor(
    public readonly pluginId: string,
    public readonly eventType: string
  ) {
    super(
      `Plugin "${pluginId}" may not emit reserved "${eventType}" — the "${RESERVED_EVENT_NAMESPACE}" namespace is host-only.`
    )
    this.name = "BusNamespaceError"
  }
}

/** Thrown when an emitted payload exceeds {@link PLUGIN_MESSAGE_MAX_BYTES}. */
export class BusPayloadTooLargeError extends Error {
  constructor(
    public readonly eventType: string,
    public readonly size: number
  ) {
    super(`Event "${eventType}" payload size ${size} exceeds maximum ${PLUGIN_MESSAGE_MAX_BYTES}`)
    this.name = "BusPayloadTooLargeError"
  }
}

/** Serialized byte length of a payload (mirrors IPC `validateMessage`). */
function byteLengthOf(payload: unknown): number {
  const serialized = JSON.stringify(payload) ?? ""
  return typeof Buffer !== "undefined"
    ? Buffer.byteLength(serialized, "utf8")
    : new Blob([serialized]).size
}

// =============================================================================
// Predefined Event Types
// =============================================================================

export const SystemEvents = {
  PLUGIN_LOADED: "system:plugin:loaded",
  PLUGIN_ENABLED: "system:plugin:enabled",
  PLUGIN_DISABLED: "system:plugin:disabled",
  PLUGIN_UNLOADED: "system:plugin:unloaded",
  PLUGIN_ERROR: "system:plugin:error",
  SESSION_CREATED: "system:session:created",
  SESSION_SWITCHED: "system:session:switched",
  SESSION_DELETED: "system:session:deleted",
  AGENT_STARTED: "system:agent:started",
  AGENT_COMPLETED: "system:agent:completed",
  AGENT_ERROR: "system:agent:error",
  MESSAGE_SENT: "system:message:sent",
  MESSAGE_RECEIVED: "system:message:received",
  // Per-tool-call lifecycle for the MAIN interactive Claude SDK chat. Emitted
  // by lib/agent-trace/chat-tool-spans.ts at the execute_tool span open/close.
  // ids + tool name + isError only (PII red-line) — never tool input/output.
  // Observability plugins (audit log / cost tracker / tool-usage analytics)
  // subscribe to react to per-tool execution in the primary chat.
  TOOL_CALL_STARTED: "system:tool:started",
  TOOL_CALL_COMPLETED: "system:tool:completed",
  THEME_CHANGED: "system:theme:changed",
  SETTINGS_CHANGED: "system:settings:changed",
  APP_READY: "system:app:ready",
  APP_CLOSING: "system:app:closing",
} as const

// =============================================================================
// Message Bus
// =============================================================================

export class MessageBus {
  private config: MessageBusConfig
  private subscriptions: Map<string, EventSubscription> = new Map()
  private eventHistory: BusEvent[] = []
  private wildcardSubscriptions: EventSubscription[] = []
  private patternSubscriptions: Array<{ pattern: RegExp; subscription: EventSubscription }> = []

  constructor(config: Partial<MessageBusConfig> = {}) {
    this.config = {
      // PR-C: source the default cap from `constants.ts` so PluginIPC
      // and MessageBus stay in lockstep. Tests / multi-tenant tweaks
      // can still override via `config.maxHistory`.
      maxHistory: PLUGIN_MESSAGE_HISTORY_MAX,
      enableLogging: false,
      enableReplay: true,
      replayWindow: 60000, // 1 minute
      ...config,
    }
  }

  // ===========================================================================
  // Event Publishing
  // ===========================================================================

  emit<T = unknown>(
    eventType: string,
    payload: T,
    source: EventSource,
    metadata?: Record<string, unknown>
  ): string {
    // Anti-spoof: only the host may publish under the reserved namespace.
    if (source.type === "plugin" && eventType.startsWith(RESERVED_EVENT_NAMESPACE)) {
      throw new BusNamespaceError(source.id, eventType)
    }
    // Parity with IPC `validateMessage` — bound the payload size so a buggy or
    // hostile plugin can't flood subscribers with an oversized event.
    const size = byteLengthOf(payload)
    if (size > PLUGIN_MESSAGE_MAX_BYTES) {
      throw new BusPayloadTooLargeError(eventType, size)
    }

    const event: BusEvent<T> = {
      id: this.generateId(),
      type: eventType,
      source,
      payload,
      timestamp: Date.now(),
      metadata,
    }

    this.recordEvent(event)
    this.log("emit", event)
    this.deliverEvent(event)

    return event.id
  }

  emitFromPlugin<T = unknown>(
    pluginId: string,
    eventType: string,
    payload: T,
    metadata?: Record<string, unknown>
  ): string {
    return this.emit(eventType, payload, { type: "plugin", id: pluginId }, metadata)
  }

  emitFromSystem<T = unknown>(
    eventType: string,
    payload: T,
    metadata?: Record<string, unknown>
  ): string {
    return this.emit(eventType, payload, { type: "system", id: "cognia" }, metadata)
  }

  // ===========================================================================
  // Subscriptions
  // ===========================================================================

  on<T = unknown>(
    eventType: string | RegExp,
    handler: EventHandler<T>,
    options: {
      source?: EventSource
      filter?: EventFilter
      priority?: number
    } = {}
  ): () => void {
    const subscription: EventSubscription = {
      id: this.generateId(),
      eventType,
      handler: handler as EventHandler,
      source: options.source || { type: "system", id: "anonymous" },
      filter: options.filter,
      priority: options.priority || 0,
      once: false,
    }

    this.addSubscription(subscription)

    return () => this.removeSubscription(subscription.id)
  }

  once<T = unknown>(
    eventType: string | RegExp,
    handler: EventHandler<T>,
    options: {
      source?: EventSource
      filter?: EventFilter
      priority?: number
    } = {}
  ): () => void {
    const subscription: EventSubscription = {
      id: this.generateId(),
      eventType,
      handler: handler as EventHandler,
      source: options.source || { type: "system", id: "anonymous" },
      filter: options.filter,
      priority: options.priority || 0,
      once: true,
    }

    this.addSubscription(subscription)

    return () => this.removeSubscription(subscription.id)
  }

  off(subscriptionId: string): void {
    this.removeSubscription(subscriptionId)
  }

  /** Remove a subscription only when `ownerId` created it (W3.7). */
  offOwned(ownerId: string, subscriptionId: string): void {
    const owns = (sub: EventSubscription) => sub.id === subscriptionId && sub.source.id === ownerId
    for (const sub of this.subscriptions.values()) {
      if (owns(sub)) {
        this.subscriptions.delete(sub.id)
        return
      }
    }
    if (this.wildcardSubscriptions.some(owns)) {
      this.wildcardSubscriptions = this.wildcardSubscriptions.filter((sub) => !owns(sub))
      return
    }
    this.patternSubscriptions = this.patternSubscriptions.filter(
      ({ subscription }) => !owns(subscription)
    )
  }

  offAll(sourceId: string): void {
    // Remove from regular subscriptions
    for (const [id, sub] of this.subscriptions.entries()) {
      if (sub.source.id === sourceId) {
        this.subscriptions.delete(id)
      }
    }

    // Remove from wildcard subscriptions
    this.wildcardSubscriptions = this.wildcardSubscriptions.filter(
      (sub) => sub.source.id !== sourceId
    )

    // Remove from pattern subscriptions
    this.patternSubscriptions = this.patternSubscriptions.filter(
      ({ subscription }) => subscription.source.id !== sourceId
    )
  }

  private addSubscription(subscription: EventSubscription): void {
    if (typeof subscription.eventType === "string") {
      if (subscription.eventType === "*") {
        this.wildcardSubscriptions.push(subscription)
        this.wildcardSubscriptions.sort((a, b) => b.priority - a.priority)
      } else {
        this.subscriptions.set(subscription.id, subscription)
      }
    } else {
      this.patternSubscriptions.push({ pattern: subscription.eventType, subscription })
      this.patternSubscriptions.sort((a, b) => b.subscription.priority - a.subscription.priority)
    }
  }

  private removeSubscription(subscriptionId: string): void {
    // Check regular subscriptions
    if (this.subscriptions.has(subscriptionId)) {
      this.subscriptions.delete(subscriptionId)
      return
    }

    // Check wildcard subscriptions
    const wildcardIndex = this.wildcardSubscriptions.findIndex((s) => s.id === subscriptionId)
    if (wildcardIndex !== -1) {
      this.wildcardSubscriptions.splice(wildcardIndex, 1)
      return
    }

    // Check pattern subscriptions
    const patternIndex = this.patternSubscriptions.findIndex(
      ({ subscription }) => subscription.id === subscriptionId
    )
    if (patternIndex !== -1) {
      this.patternSubscriptions.splice(patternIndex, 1)
    }
  }

  // ===========================================================================
  // Event Delivery
  // ===========================================================================

  /**
   * Synchronous delivery depth. Handlers may emit while being delivered to;
   * beyond MAX_SYNC_DELIVER_DEPTH the nested emit is deferred to a microtask
   * so a re-emitting handler pair can't blow the stack (W3.7).
   */
  private deliverDepth = 0
  private static readonly MAX_SYNC_DELIVER_DEPTH = 16

  private deliverEvent(event: BusEvent): void {
    if (this.deliverDepth >= MessageBus.MAX_SYNC_DELIVER_DEPTH) {
      queueMicrotask(() => this.deliverEvent(event))
      return
    }
    this.deliverDepth++
    try {
      this.deliverEventNow(event)
    } finally {
      this.deliverDepth--
    }
  }

  private deliverEventNow(event: BusEvent): void {
    const toRemove: string[] = []

    // Collect matching subscriptions
    const matchingSubscriptions: EventSubscription[] = []

    // Check exact matches
    for (const subscription of this.subscriptions.values()) {
      if (subscription.eventType === event.type && this.matchesFilter(event, subscription.filter)) {
        matchingSubscriptions.push(subscription)
      }
    }

    // Check pattern matches
    for (const { pattern, subscription } of this.patternSubscriptions) {
      if (pattern.test(event.type) && this.matchesFilter(event, subscription.filter)) {
        matchingSubscriptions.push(subscription)
      }
    }

    // Check wildcard subscriptions
    for (const subscription of this.wildcardSubscriptions) {
      if (this.matchesFilter(event, subscription.filter)) {
        matchingSubscriptions.push(subscription)
      }
    }

    // Sort by priority and deliver
    matchingSubscriptions.sort((a, b) => b.priority - a.priority)

    for (const subscription of matchingSubscriptions) {
      try {
        subscription.handler(event)

        if (subscription.once) {
          toRemove.push(subscription.id)
        }
      } catch (error) {
        loggers.manager.error(`[MessageBus] Handler error for ${event.type}:`, error)
      }
    }

    // Remove one-time subscriptions
    for (const id of toRemove) {
      this.removeSubscription(id)
    }
  }

  private matchesFilter(event: BusEvent, filter?: EventFilter): boolean {
    if (!filter) return true

    if (filter.sourceType && event.source.type !== filter.sourceType) {
      return false
    }

    if (filter.sourceId && event.source.id !== filter.sourceId) {
      return false
    }

    if (filter.metadata) {
      for (const [key, value] of Object.entries(filter.metadata)) {
        if (event.metadata?.[key] !== value) {
          return false
        }
      }
    }

    return true
  }

  // ===========================================================================
  // Event Replay
  // ===========================================================================

  replay(
    eventType: string | RegExp,
    handler: EventHandler,
    options: {
      since?: number
      limit?: number
    } = {}
  ): number {
    if (!this.config.enableReplay) return 0

    const since = options.since || Date.now() - this.config.replayWindow
    const limit = options.limit || this.eventHistory.length

    let count = 0
    const recentEvents = this.eventHistory
      .filter((e) => e.timestamp >= since)
      .filter((e) => {
        if (typeof eventType === "string") {
          return e.type === eventType
        }
        return eventType.test(e.type)
      })
      .slice(-limit)

    for (const event of recentEvents) {
      try {
        handler(event)
        count++
      } catch (error) {
        loggers.manager.error("[MessageBus] Replay handler error:", error)
      }
    }

    return count
  }

  // ===========================================================================
  // History Management
  // ===========================================================================

  private recordEvent(event: BusEvent): void {
    this.eventHistory.push(event)
    if (this.eventHistory.length > this.config.maxHistory) {
      this.eventHistory = this.eventHistory.slice(-this.config.maxHistory)
    }
  }

  getHistory(options?: {
    eventType?: string | RegExp
    sourceId?: string
    since?: number
    limit?: number
    /**
     * Plugin id asking for history (W3.6). When set, payloads of OTHER
     * plugins' events are stripped (replaced with undefined + a
     * `payloadRedacted` metadata flag) — the retention window is not a
     * cross-plugin data leak. System/user-sourced events keep their payloads
     * (they are ids-only by design; see adapter-hooks' PII note).
     */
    viewerId?: string
  }): BusEvent[] {
    let events = [...this.eventHistory]

    if (options?.eventType) {
      if (typeof options.eventType === "string") {
        events = events.filter((e) => e.type === options.eventType)
      } else {
        events = events.filter((e) => (options.eventType as RegExp).test(e.type))
      }
    }

    if (options?.sourceId) {
      events = events.filter((e) => e.source.id === options.sourceId)
    }

    if (options?.since !== undefined) {
      const since = options.since
      events = events.filter((e) => e.timestamp >= since)
    }

    if (options?.limit) {
      events = events.slice(-options.limit)
    }

    const viewerId = options?.viewerId
    if (viewerId) {
      events = events.map((e) =>
        e.source.type === "plugin" && e.source.id !== viewerId
          ? {
              ...e,
              payload: undefined,
              metadata: { ...e.metadata, payloadRedacted: true },
            }
          : e
      )
    }

    return events
  }

  clearHistory(): void {
    this.eventHistory = []
  }

  // ===========================================================================
  // Utilities
  // ===========================================================================

  private generateId(): string {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`
  }

  private log(action: string, data: unknown): void {
    if (this.config.enableLogging) {
      loggers.manager.debug(`[MessageBus] ${action}:`, data)
    }
  }

  // ===========================================================================
  // Introspection
  // ===========================================================================

  getSubscriptionCount(): number {
    return (
      this.subscriptions.size + this.wildcardSubscriptions.length + this.patternSubscriptions.length
    )
  }

  getSubscriptionsBySource(sourceId: string): string[] {
    const types: string[] = []

    for (const sub of this.subscriptions.values()) {
      if (sub.source.id === sourceId && typeof sub.eventType === "string") {
        types.push(sub.eventType)
      }
    }

    return types
  }

  getStats(): {
    totalSubscriptions: number
    wildcardSubscriptions: number
    patternSubscriptions: number
    historySize: number
  } {
    return {
      totalSubscriptions: this.subscriptions.size,
      wildcardSubscriptions: this.wildcardSubscriptions.length,
      patternSubscriptions: this.patternSubscriptions.length,
      historySize: this.eventHistory.length,
    }
  }

  // ===========================================================================
  // Cleanup
  // ===========================================================================

  clear(): void {
    this.subscriptions.clear()
    this.wildcardSubscriptions = []
    this.patternSubscriptions = []
    this.eventHistory = []
  }
}

// =============================================================================
// Singleton Instance
// =============================================================================

let messageBusInstance: MessageBus | null = null

export function getMessageBus(config?: Partial<MessageBusConfig>): MessageBus {
  if (!messageBusInstance) {
    messageBusInstance = new MessageBus(config)
  }
  return messageBusInstance
}

export function resetMessageBus(): void {
  if (messageBusInstance) {
    messageBusInstance.clear()
    messageBusInstance = null
  }
}

/**
 * Best-effort host publish of a `system:*` event. Wraps
 * {@link MessageBus.emitFromSystem} in a try/catch so a bus failure (a buggy
 * subscriber, a payload-bound violation) NEVER blocks the host action it rides
 * on — mirrors the lifecycle-event emit in `lib/plugin/core/manager.ts`.
 *
 * Payloads must carry ids only (sessionId / teamId / runId / agentId), never
 * message text or prompt content — the bus is reachable by any plugin holding
 * `events:subscribe`.
 */
export function emitSystemBusEvent(
  eventType: string,
  payload: unknown,
  metadata?: Record<string, unknown>
): void {
  try {
    getMessageBus().emitFromSystem(eventType, payload, metadata)
  } catch (error) {
    loggers.manager.error(`[MessageBus] system emit failed for "${eventType}":`, error)
  }
}

// =============================================================================
// Plugin Event API Factory
// =============================================================================

export function createEventAPI(pluginId: string): PluginEventAPI {
  const bus = getMessageBus()
  const source: EventSource = { type: "plugin", id: pluginId }

  // Pub/sub is permission-gated, mirroring the IPC façade. Publishing requires
  // `events:publish`; subscribing / reading history requires `events:subscribe`.
  // Cleanup (`off`/`offAll`) stays ungated so a revoked plugin can still tear
  // its own subscriptions down. Reserved-namespace + payload-size guards live
  // in `MessageBus.emit` so direct `emitFromPlugin` callers are covered too.
  const requirePerm = (permission: "events:publish" | "events:subscribe", method: string): void => {
    if (!pluginHasApiPermission(pluginId, permission)) {
      throw new Error(
        `events.${method} requires the "${permission}" permission — declare it in the plugin manifest.`
      )
    }
  }

  return {
    emit: <T>(eventType: string, payload: T, metadata?: Record<string, unknown>) => {
      requirePerm("events:publish", "emit")
      return bus.emit(eventType, payload, source, metadata)
    },

    on: <T>(eventType: string | RegExp, handler: EventHandler<T>, filter?: EventFilter) => {
      requirePerm("events:subscribe", "on")
      return bus.on(eventType, handler, { source, filter })
    },

    once: <T>(eventType: string | RegExp, handler: EventHandler<T>, filter?: EventFilter) => {
      requirePerm("events:subscribe", "once")
      return bus.once(eventType, handler, { source, filter })
    },

    // Owner-scoped (W3.7): a plugin can only remove ITS OWN subscriptions —
    // `bus.off(id)` was owner-unaware, and the ids handed to plugins come from
    // the unsubscribe closures anyway.
    off: (subscriptionId: string) => bus.offOwned(pluginId, subscriptionId),

    offAll: () => bus.offAll(pluginId),

    getHistory: (eventType?: string | RegExp, limit?: number) => {
      requirePerm("events:subscribe", "getHistory")
      return bus.getHistory({ eventType, limit, viewerId: pluginId })
    },
  }
}

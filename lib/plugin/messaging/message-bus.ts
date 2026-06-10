/**
 * Plugin Message Bus
 *
 * Global event bus for cross-plugin and system-wide events.
 * Provides typed event handling with namespacing and filtering.
 */

import { loggers } from "../core/logger"
import { PLUGIN_MESSAGE_HISTORY_MAX } from "./constants"
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

  private deliverEvent(event: BusEvent): void {
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

// =============================================================================
// Plugin Event API Factory
// =============================================================================

export function createEventAPI(pluginId: string): PluginEventAPI {
  const bus = getMessageBus()
  const source: EventSource = { type: "plugin", id: pluginId }

  return {
    emit: <T>(eventType: string, payload: T, metadata?: Record<string, unknown>) =>
      bus.emit(eventType, payload, source, metadata),

    on: <T>(eventType: string | RegExp, handler: EventHandler<T>, filter?: EventFilter) =>
      bus.on(eventType, handler, { source, filter }),

    once: <T>(eventType: string | RegExp, handler: EventHandler<T>, filter?: EventFilter) =>
      bus.once(eventType, handler, { source, filter }),

    off: (subscriptionId: string) => bus.off(subscriptionId),

    offAll: () => bus.offAll(pluginId),

    getHistory: (eventType?: string | RegExp, limit?: number) =>
      bus.getHistory({ eventType, limit }),
  }
}

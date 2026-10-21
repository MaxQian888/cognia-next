/**
 * The plugin contract's share of `lib/plugin/messaging/message-bus.ts`, which re-exports these.
 */
import type { BusEvent, EventFilter, EventSource } from "../../../types/plugin/plugin-messaging"

export interface EventSubscription {
  id: string
  eventType: string | RegExp
  handler: (event: BusEvent) => void
  source: EventSource
  filter?: EventFilter
  priority: number
  once: boolean
}

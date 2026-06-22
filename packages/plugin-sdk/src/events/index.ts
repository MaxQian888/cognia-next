/**
 * Plugin SDK — `events` subpath.
 *
 * Re-exports the message-bus types plugin authors need to listen / emit
 * cross-plugin and host events. The host-side `MessageBus` class and
 * factory functions are intentionally NOT re-exported — those are runtime
 * internals owned by the host. Plugin authors interact with events through
 * `ctx.events` (typed via `PluginEventEmitter` in
 * `@cognia/plugin-sdk/context`) or the optional `PluginEventAPI` façade
 * surfaced from the message bus.
 *
 * Source: `lib/plugin/messaging/message-bus.ts`.
 */

export type {
  BusEvent,
  EventSource,
  EventSubscription,
  EventFilter,
  MessageBusConfig,
  PluginEventAPI,
} from "@/lib/plugin/messaging/message-bus"

export { SystemEvents } from "@/lib/plugin/messaging/message-bus"

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
  EventFilter,
  EventSubscription,
  PluginEventAPI,
} from "@/lib/plugin/messaging/message-bus"

/** Stable host event names available through `ctx.events`. */
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
  TOOL_CALL_STARTED: "system:tool:started",
  TOOL_CALL_COMPLETED: "system:tool:completed",
  THEME_CHANGED: "system:theme:changed",
  SETTINGS_CHANGED: "system:settings:changed",
  APP_READY: "system:app:ready",
  APP_CLOSING: "system:app:closing",
} as const

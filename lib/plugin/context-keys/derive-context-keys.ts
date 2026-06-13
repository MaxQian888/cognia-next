// Pure projection of live app state → the flat context-key map consumed by
// `when`-clause evaluation. Kept side-effect-free so it can be unit-tested
// without mounting React; the `ContextKeysInitializer` component feeds the
// real store values in and pushes the result via `setContextKeys`.
//
// Route keys are handled separately (imperatively) by the initializer because
// route ids are open-ended — see the component's route effect.

import type { ContextValue } from "./context-key-store"

export type GuildKind = "dm" | "team" | "canvas"

export interface ContextKeyInputs {
  /** Running inside the Tauri desktop shell (vs. the browser/web profile). */
  isTauri: boolean
  /** Detected OS, used for `platform.<os>` predicates. */
  os: "windows" | "macos" | "linux" | "unknown"
  /** A chat session is selected. */
  chatActive: boolean
  /** The active session is currently streaming a response. */
  chatStreaming: boolean
  /** The active session has at least one message. */
  chatHasMessages: boolean
  /** A workspace/project is active. */
  projectActive: boolean
  /** The currently selected guild rail kind. */
  guildKind: GuildKind
  /** Every plugin id the host knows about (enabled or not). */
  allPluginIds: string[]
  /** The subset of `allPluginIds` whose status is `enabled`. */
  enabledPluginIds: string[]
}

/**
 * Build the flat context-key map for everything except route keys. Each
 * enumerated dimension (platform, guild) emits the full set of booleans so a
 * flip clears the previous value in the same `setContextKeys` call.
 */
export function deriveContextKeys(input: ContextKeyInputs): Record<string, ContextValue> {
  const enabled = new Set(input.enabledPluginIds)
  const keys: Record<string, ContextValue> = {
    "platform.tauri": input.isTauri,
    "platform.web": !input.isTauri,
    "platform.windows": input.os === "windows",
    "platform.macos": input.os === "macos",
    "platform.linux": input.os === "linux",

    "chat.active": input.chatActive,
    "chat.streaming": input.chatStreaming,
    "chat.hasMessages": input.chatHasMessages,

    "project.active": input.projectActive,

    "view.dm": input.guildKind === "dm",
    "view.team": input.guildKind === "team",
    "view.canvas": input.guildKind === "canvas",
    "agent.teamActive": input.guildKind === "team",
  }

  for (const id of input.allPluginIds) {
    keys[`plugin.${id}.enabled`] = enabled.has(id)
  }

  return keys
}

/** Detect the host OS from `navigator.platform`. Safe in non-browser contexts. */
export function detectOs(): ContextKeyInputs["os"] {
  if (typeof navigator === "undefined" || !navigator.platform) return "unknown"
  const p = navigator.platform.toLowerCase()
  if (p.includes("win")) return "windows"
  if (p.includes("mac")) return "macos"
  if (p.includes("linux")) return "linux"
  return "unknown"
}

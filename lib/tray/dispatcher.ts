// Routes `tray://item-clicked` payloads (and the matching
// `shortcut://triggered` events) through the existing dispatch surfaces so
// every tray-driven action reuses the same code path the chat composer and
// command palette take.
//
// No new dispatch logic — purely a switch:
//   - `kind: "native"` actions are handled by Rust; the renderer side just
//     swallows them here.
//   - `kind: "slash"` goes to `dispatchSlashCommand("/" + command)` from
//     `lib/slash-commands/registry.ts:113`.
//   - `kind: "command"` goes to `executeCommand` from
//     `lib/plugin/commands/registry.ts`.

import { dispatchSlashCommand } from "@/lib/slash-commands/registry"
import { executeCommand, getCommand } from "@/lib/plugin/commands/registry"
import { loggers } from "@cognia/logging"

import { useTrayStore } from "./store"
import { requestTrayUsageRefresh } from "./usage-refresh-bus"
import {
  USAGE_METRIC_COMMAND_PREFIX,
  USAGE_PERIOD_COMMAND_PREFIX,
  USAGE_REFRESH_COMMAND,
  USAGE_SCOPE_COMMAND_PREFIX,
  USAGE_SELECT_COMMAND_PREFIX,
} from "./usage-section"
import {
  USAGE_GLANCE_METRICS,
  USAGE_GLANCE_PERIODS,
  USAGE_GLANCE_SCOPES,
  type UsageGlanceMetric,
  type UsageGlancePeriod,
  type UsageGlanceScope,
} from "@/lib/usage/usage-glance"

const hasCommand = (id: string) => getCommand(id) !== undefined

import type { TrayActionPayload } from "./types"

/**
 * Tray-internal command ids (usage refresh / pin-selection) never enter the
 * unified command registry — the rows are synthesized per menu build with
 * dynamic account keys, so they are routed here instead. Returns `true` when
 * the id was one of ours.
 */
export function handleTrayUsageCommand(commandId: string): boolean {
  if (commandId === USAGE_REFRESH_COMMAND) {
    requestTrayUsageRefresh()
    return true
  }
  if (commandId.startsWith(USAGE_SELECT_COMMAND_PREFIX)) {
    const key = commandId.slice(USAGE_SELECT_COMMAND_PREFIX.length)
    // Empty key = the "Auto" row → follow the worst-utilized account.
    useTrayStore.getState().setDisplay({ usageAccountKey: key.length > 0 ? key : null })
    return true
  }
  // The three glance dimensions (ADR-0165). Each value is validated against
  // its declared vocabulary before it reaches the store: these ids are built
  // from persisted prefs and a stale menu could otherwise write a value no
  // reader knows how to render.
  if (commandId.startsWith(USAGE_METRIC_COMMAND_PREFIX)) {
    const value = commandId.slice(USAGE_METRIC_COMMAND_PREFIX.length) as UsageGlanceMetric
    if (USAGE_GLANCE_METRICS.includes(value)) {
      useTrayStore.getState().setDisplay({ usageMetric: value })
    }
    return true
  }
  if (commandId.startsWith(USAGE_PERIOD_COMMAND_PREFIX)) {
    const value = commandId.slice(USAGE_PERIOD_COMMAND_PREFIX.length) as UsageGlancePeriod
    if (USAGE_GLANCE_PERIODS.includes(value)) {
      useTrayStore.getState().setDisplay({ usagePeriod: value })
    }
    return true
  }
  if (commandId.startsWith(USAGE_SCOPE_COMMAND_PREFIX)) {
    const value = commandId.slice(USAGE_SCOPE_COMMAND_PREFIX.length) as UsageGlanceScope
    if (USAGE_GLANCE_SCOPES.includes(value)) {
      useTrayStore.getState().setDisplay({ usageScope: value })
    }
    return true
  }
  return false
}

export async function dispatchTrayClick(payload: TrayActionPayload | undefined): Promise<void> {
  if (!payload) return
  switch (payload.kind) {
    case "native":
      // Rust handles the native action plus emits a legacy `tray://<x>`
      // event for `hooks/system/use-tauri-events.ts` to consume.
      return
    case "slash": {
      const line = payload.command.startsWith("/") ? payload.command : `/${payload.command}`
      try {
        await dispatchSlashCommand(line)
      } catch (err) {
        loggers.tray?.warn?.("tray slash dispatch failed", { command: line, error: String(err) })
      }
      return
    }
    case "command":
      if (handleTrayUsageCommand(payload.commandId)) return
      if (!hasCommand(payload.commandId)) {
        loggers.tray?.warn?.("tray click referenced unregistered command", {
          commandId: payload.commandId,
        })
        return
      }
      try {
        await executeCommand(payload.commandId)
      } catch (err) {
        loggers.tray?.warn?.("tray command dispatch failed", {
          commandId: payload.commandId,
          error: String(err),
        })
      }
  }
}

/**
 * Mirror of `dispatchTrayClick` for `shortcut://triggered { id }` events.
 * The renderer's shortcut bindings map `id → handler`; the built-in
 * `tray.show / tray.open-logs / tray.automation-kill` ids are already
 * handled inside Rust's `ShortcutRegistry::dispatch`, so they bottom out
 * here as a no-op. For renderer-bound ids (e.g. `goal.pause`), this looks
 * up the matching action in the unified command registry.
 */
export async function dispatchShortcut(id: string): Promise<void> {
  if (!id) return
  if (id.startsWith("tray.")) {
    // Built-in tray bindings — Rust already did the work. Renderer-side
    // mirrors (toast, badge updates) happen via the legacy `tray://*`
    // events emitted alongside.
    return
  }
  if (hasCommand(id)) {
    try {
      await executeCommand(id)
    } catch (err) {
      loggers.tray?.warn?.("shortcut dispatch failed", { id, error: String(err) })
    }
    return
  }
  loggers.tray?.warn?.("shortcut id has no registered handler", { id })
}

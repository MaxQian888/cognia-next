/**
 * Fleet-monitoring hook catalog for externally-launched Claude Code.
 *
 * Follows the `BUILTIN_HOOKS` registry shape (`builtin-hooks.ts`) but targets
 * the USER-scope `~/.claude/settings.json` hooks block directly: unlike
 * built-ins (merged at runtime for cognia-run sessions), fleet hooks must be
 * present in the file so Claude Code instances the user launches in any
 * terminal execute them. Install/uninstall go through the single settings
 * writer (`lib/claude/settings.ts` read → patch `hooks` → write full payload)
 * — never a second ad-hoc writer.
 *
 * Every installed handler is recognizable by the managed command prefix (the
 * generated `claude-hook.sh` path), so uninstall removes exactly ours and a
 * status check can detect foreign edits. The hook script itself is generated
 * by Rust (`src-tauri/src/fleet/install.rs`) and fails open: with the fleet
 * monitor off (or Cognia closed) each hook exits 0 in ~10 ms.
 */

import type { HookEvent, HookGroup, HooksConfig } from "@/lib/claude/hooks"
import {
  readClaudeUserSettings,
  writeClaudeUserSettings,
  type ClaudeSettings,
} from "@/lib/claude/settings"
import { invoke } from "@tauri-apps/api/core"

/** One fleet hook contribution: event + forwarding mode. */
export interface FleetHookDef {
  event: HookEvent
  /**
   * `fire` — fire-and-forget (0.4 s curl budget); `wait` — long-poll the
   * island for a decision (PermissionRequest only).
   */
  mode: "fire" | "wait"
  /**
   * settings.json `timeout` (seconds) for the hook entry. Only the wait hook
   * sets one: 30 s sits above the script's 25 s curl budget, which sits above
   * the island's 20 s answer window (fail-open ladder).
   */
  timeout?: number
}

/**
 * Events the fleet monitor observes. Deliberately excludes high-frequency
 * no-signal events (PostToolBatch, FileChanged) — every entry costs a process
 * spawn per event in the user's session.
 */
export const FLEET_HOOKS: readonly FleetHookDef[] = [
  { event: "SessionStart", mode: "fire" },
  { event: "UserPromptSubmit", mode: "fire" },
  { event: "PreToolUse", mode: "fire" },
  { event: "PostToolUse", mode: "fire" },
  { event: "Notification", mode: "fire" },
  { event: "Stop", mode: "fire" },
  { event: "SubagentStop", mode: "fire" },
  { event: "SessionEnd", mode: "fire" },
  { event: "PermissionRequest", mode: "wait", timeout: 30 },
] as const

/** Mirror of the Rust `FleetScriptsStatus` DTO (`fleet/install.rs`). */
export interface FleetScriptsStatus {
  claudeScript: "installed" | "stale" | "missing"
  claudeScriptPath: string | null
  monitorConfigPresent: boolean
}

/** Install state of the fleet hooks inside `~/.claude/settings.json`. */
export type FleetHooksInstallState =
  | "installed"
  | "partial"
  | "not-installed"
  /** `~/.claude/` itself is missing — Claude Code isn't installed. */
  | "unavailable"

/** Quote a path for the hook command line, tolerating spaces. */
function quote(p: string): string {
  return `"${p.replace(/"/g, '\\"')}"`
}

/** The command string for one fleet hook entry. */
export function fleetHookCommand(scriptPath: string, def: FleetHookDef): string {
  return `${quote(scriptPath)} ${def.event} ${def.mode}`
}

/** True when a hook handler belongs to the fleet catalog (ours to manage). */
export function isFleetHookHandler(handler: unknown, scriptPath?: string): boolean {
  if (typeof handler !== "object" || handler === null) return false
  const h = handler as { type?: unknown; command?: unknown }
  if (h.type !== "command" || typeof h.command !== "string") return false
  if (scriptPath) return h.command.startsWith(quote(scriptPath))
  // Fallback marker: the generated script's stable filename.
  return h.command.includes("agent-monitor/claude-hook.sh")
}

function isFleetGroup(group: unknown, scriptPath?: string): boolean {
  if (typeof group !== "object" || group === null) return false
  const hooks = (group as { hooks?: unknown }).hooks
  return Array.isArray(hooks) && hooks.some((h) => isFleetHookHandler(h, scriptPath))
}

/** Build the fleet hook groups keyed by event. Pure. */
export function buildFleetHookGroups(scriptPath: string): HooksConfig {
  const out: HooksConfig = {}
  for (const def of FLEET_HOOKS) {
    const group: HookGroup = {
      hooks: [
        {
          type: "command",
          command: fleetHookCommand(scriptPath, def),
          ...(def.timeout ? { timeout: def.timeout } : {}),
        },
      ],
    }
    ;(out[def.event] ??= []).push(group)
  }
  return out
}

/**
 * Remove every fleet-managed group from a hooks block. Pure — returns a new
 * object; user-authored groups (and unknown events) pass through untouched.
 */
export function stripFleetGroups(
  hooks: Record<string, unknown> | undefined,
  scriptPath?: string
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [event, groups] of Object.entries(hooks ?? {})) {
    if (!Array.isArray(groups)) {
      out[event] = groups
      continue
    }
    const kept = groups.filter((g) => !isFleetGroup(g, scriptPath))
    if (kept.length > 0) out[event] = kept
  }
  return out
}

/**
 * Merge the fleet groups into a hooks block (fleet groups appended after the
 * user's own, mirroring `mergeBuiltinUnder` ordering). Pure. Idempotent when
 * composed with `stripFleetGroups` first.
 */
export function withFleetGroups(
  hooks: Record<string, unknown> | undefined,
  scriptPath: string
): Record<string, unknown> {
  const base = stripFleetGroups(hooks, scriptPath)
  const fleet = buildFleetHookGroups(scriptPath)
  const out: Record<string, unknown> = { ...base }
  for (const [event, groups] of Object.entries(fleet)) {
    const existing = out[event]
    out[event] = Array.isArray(existing) ? [...existing, ...groups] : groups
  }
  return out
}

/** Classify the install state of a hooks block. Pure. */
export function classifyFleetInstall(
  hooks: Record<string, unknown> | undefined,
  scriptPath?: string
): Exclude<FleetHooksInstallState, "unavailable"> {
  const events = new Set(
    Object.entries(hooks ?? {})
      .filter(
        ([, groups]) => Array.isArray(groups) && groups.some((g) => isFleetGroup(g, scriptPath))
      )
      .map(([event]) => event)
  )
  if (events.size === 0) return "not-installed"
  const expected = FLEET_HOOKS.map((d) => d.event)
  return expected.every((e) => events.has(e)) ? "installed" : "partial"
}

/**
 * Install (or refresh) the fleet hooks:
 * 1. Ask Rust to (re)generate `~/.cognia/agent-monitor/claude-hook.sh`.
 * 2. read → patch `hooks` → write the full user settings payload.
 *
 * Throws when `~/.claude/` doesn't exist (the writer refuses to materialize
 * settings for users without Claude Code) — callers surface that as
 * `unavailable`.
 */
export async function installFleetHooks(): Promise<FleetScriptsStatus> {
  const status = await invoke<FleetScriptsStatus>("fleet_scripts_install")
  if (!status.claudeScriptPath) throw new Error("fleet hook script path unavailable")
  const settings: ClaudeSettings = (await readClaudeUserSettings()) ?? {}
  const hooks = withFleetGroups(settings.hooks, status.claudeScriptPath)
  await writeClaudeUserSettings({ ...settings, hooks })
  return status
}

/**
 * Uninstall: strip our groups from settings.json first, then remove the
 * generated script (reverse order would leave dangling command entries).
 */
export async function uninstallFleetHooks(): Promise<FleetScriptsStatus> {
  const settings = await readClaudeUserSettings()
  if (settings) {
    const hooks = stripFleetGroups(settings.hooks)
    await writeClaudeUserSettings({ ...settings, hooks })
  }
  return invoke<FleetScriptsStatus>("fleet_scripts_uninstall")
}

/** Combined settings.json + script status for the settings card. */
export interface FleetHooksStatus {
  install: FleetHooksInstallState
  scripts: FleetScriptsStatus
}

export async function readFleetHooksStatus(): Promise<FleetHooksStatus> {
  const scripts = await invoke<FleetScriptsStatus>("fleet_scripts_status")
  let settings: ClaudeSettings | null = null
  try {
    settings = await readClaudeUserSettings()
  } catch {
    return { install: "unavailable", scripts }
  }
  if (settings === null) {
    // Missing file is fine (fresh Claude install) — hooks simply not there.
    return { install: "not-installed", scripts }
  }
  return {
    install: classifyFleetInstall(settings.hooks, scripts.claudeScriptPath ?? undefined),
    scripts,
  }
}

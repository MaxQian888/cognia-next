/**
 * Product-bundled built-in hooks registry.
 *
 * cognia ships a small, curated set of lifecycle hooks (the same System-B
 * settings.json command-hook contract users author by hand) so the agent
 * arrives with useful behavior out of the box. This mirrors the repo's other
 * "built-in X" registries (e.g. `lib/plugin/core/browser-builtin-registry.ts`):
 * a hand-maintained static list resolved into runnable hook groups.
 *
 * The groups are merged **under** the user's own settings (user/cognia hooks
 * are evaluated first), and every entry is individually overridable via
 * `builtinHookOverrides` (id → enabled). Default-on entries are harmless
 * (auto-context only adds context when a file exists); guards default to OFF so
 * a fresh install never unexpectedly blocks a turn.
 *
 * Scripts live in `hooks/builtin/*.mjs` (self-contained Node, no `lib/`
 * imports) so they run as spawned command hooks in both the desktop (Rust) and
 * CLI runtimes. `baseDir` is the resolved absolute path to that directory in
 * the current shell.
 */

import type { HookEvent, HookGroup, HooksConfig } from "@/lib/claude/hooks"

/** One bundled hook contribution. */
export interface BuiltinHookDef {
  /** Stable id used by `builtinHookOverrides` and the settings UI. */
  id: string
  /** Lifecycle event this hook fires on. */
  event: HookEvent
  /** Optional tool-name matcher (for tool-scoped events). */
  matcher?: string
  /** Script filename within the bundled `hooks/builtin/` dir. */
  script: string
  /** i18n-independent short description (the UI shows a translated label). */
  description: string
  /** Whether this hook runs without an explicit user opt-in. */
  defaultEnabled: boolean
}

/** The curated catalog. Order is stable for deterministic merge + UI listing. */
export const BUILTIN_HOOKS: readonly BuiltinHookDef[] = [
  {
    id: "auto-context-loader",
    event: "SessionStart",
    script: "auto-context-loader.mjs",
    description: "Inject .cognia/agent-context.md as standing context at session start.",
    defaultEnabled: true,
  },
  {
    id: "auto-context-loader-prompt",
    event: "UserPromptSubmit",
    script: "auto-context-loader.mjs",
    description: "Inject .cognia/agent-context.md as standing context on every prompt.",
    defaultEnabled: true,
  },
  {
    id: "cost-quota-guard",
    event: "UserPromptSubmit",
    script: "cost-quota-guard.mjs",
    description: "Deny a turn once the session token budget is exceeded.",
    defaultEnabled: false,
  },
  {
    id: "pii-safety-guard",
    event: "UserPromptSubmit",
    script: "pii-safety-guard.mjs",
    description: "Block a prompt that carries obvious PII / credentials.",
    defaultEnabled: false,
  },
  {
    id: "pii-safety-guard-tool",
    event: "PreToolUse",
    script: "pii-safety-guard.mjs",
    description: "Block a tool call whose input carries obvious PII / credentials.",
    defaultEnabled: false,
  },
] as const

/** Per-id enable/disable overrides (id → enabled). */
export type BuiltinHookOverrides = Record<string, boolean>

/** Resolve whether one built-in hook is active given the user's overrides. */
export function isBuiltinHookEnabled(
  def: BuiltinHookDef,
  overrides: BuiltinHookOverrides
): boolean {
  return overrides[def.id] ?? def.defaultEnabled
}

/** Quote a path for a shell command, tolerating spaces on every platform. */
function quote(p: string): string {
  return `"${p.replace(/"/g, '\\"')}"`
}

/** Join a base dir + script name into an absolute path (POSIX-normalized join). */
function joinPath(baseDir: string, script: string): string {
  const trimmed = baseDir.replace(/[\\/]+$/, "")
  return `${trimmed}/${script}`
}

/**
 * Build the runnable hook groups for the enabled built-in hooks, keyed by
 * event. `baseDir` is the absolute path to the bundled `hooks/builtin/` dir;
 * `node` must be on PATH (it is for both shells that run command hooks).
 */
export function buildBuiltinHookGroups(opts: {
  baseDir: string
  overrides?: BuiltinHookOverrides
  /** Node executable to invoke (defaults to `node`). */
  nodeBin?: string
}): HooksConfig {
  const overrides = opts.overrides ?? {}
  const nodeBin = opts.nodeBin ?? "node"
  const out: HooksConfig = {}
  for (const def of BUILTIN_HOOKS) {
    if (!isBuiltinHookEnabled(def, overrides)) continue
    const command = `${nodeBin} ${quote(joinPath(opts.baseDir, def.script))}`
    const group: HookGroup = {
      ...(def.matcher ? { matcher: def.matcher } : {}),
      hooks: [{ type: "command", command }],
    }
    ;(out[def.event] ??= []).push(group)
  }
  return out
}

/**
 * Merge built-in hook groups **under** an existing config: for each event the
 * user/cognia groups run first, then the built-in groups. Pure — no I/O.
 */
export function mergeBuiltinUnder(base: HooksConfig, builtin: HooksConfig): HooksConfig {
  const merged: HooksConfig = {}
  const events = new Set<HookEvent>([
    ...(Object.keys(base) as HookEvent[]),
    ...(Object.keys(builtin) as HookEvent[]),
  ])
  for (const event of events) {
    const groups = [...(base[event] ?? []), ...(builtin[event] ?? [])]
    if (groups.length > 0) merged[event] = groups
  }
  return merged
}

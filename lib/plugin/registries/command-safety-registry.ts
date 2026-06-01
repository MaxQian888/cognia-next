/**
 * Command-safety rule registry — plugin-contributed `command-glob →
 * allow|ask|deny` overrides for the agent's shell Auto-mode
 * (`lib/claude/permissions/auto-mode.ts`).
 *
 * A plugin holding the `terminal:safety` permission calls
 * `ctx.terminal.registerCommandSafetyRule(...)` (see
 * `lib/plugin/api/terminal-api.ts`); that funnels here. The Auto-mode runner
 * pulls every plugin's rules via `getPluginCommandRulesets()` and feeds them
 * to the orchestrator at *lower* precedence than the user's own
 * `agentPermissions.commandRules`, so a plugin can tighten (deny a
 * known-dangerous internal command) or loosen (allow a trusted house tool)
 * the policy without ever overriding an explicit user choice.
 *
 * One merged `ToolRules` map per plugin; re-registering merges. The plugin
 * manager drops a plugin's whole contribution on disable via
 * `unregisterByPlugin`.
 */

import type { ToolRules, Ruleset } from "@/lib/claude/permissions/ruleset"
import { createOverlayRegistry } from "./createOverlayRegistry"

const registry = createOverlayRegistry<ToolRules>({ name: "command-safety" })

/**
 * Register (merge) a plugin's command rules. Returns a disposer that removes
 * exactly this registration's keys are owned per-plugin, so the disposer drops
 * the whole plugin entry.
 */
export function registerPluginCommandRules(pluginId: string, rules: ToolRules): () => void {
  const existing = registry.get(pluginId) ?? {}
  registry.register(pluginId, { ...existing, ...rules }, { pluginId })
  return () => {
    registry.unregisterByPlugin(pluginId)
  }
}

/** Drop every command rule contributed by `pluginId` (plugin disable/uninstall). */
export function unregisterPluginCommandRules(pluginId: string): number {
  return registry.unregisterByPlugin(pluginId)
}

/**
 * Every plugin's rules as a low→high-precedence list of single-tool rulesets
 * (`{ Bash: rules }`), ready to prepend to the user rules in the Auto-mode
 * orchestrator.
 */
export function getPluginCommandRulesets(): Ruleset[] {
  return registry.entries().map(({ entry }) => ({ Bash: entry }))
}

/** Test-only reset. */
export function __resetCommandSafetyRegistry(): void {
  registry.__resetForTesting()
}

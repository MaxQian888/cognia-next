/**
 * Feature-command registration barrel. The App imports this once; calling
 * `registerFeatureCommands()` adds every feature cluster's descriptors to the
 * registry on top of the core catalog. Idempotent (guarded) so repeated imports
 * / renders never double-register (the registry throws on duplicates).
 */
import { registerCommands } from "./registry"
import { COGNIA_COMMANDS } from "./cognia-commands"
import { MCP_COMMANDS } from "./mcp-commands"
import { PARITY_COMMANDS } from "./parity-commands"
import { EXPAND_COMMANDS } from "./expand-command"
import { INSPECT_COMMANDS } from "./inspect-command"
import { KEYBIND_COMMANDS } from "./keybind-command"
import { menuCommand } from "./menu-command"
import { PLUGIN_COMMANDS } from "./plugin-commands"
import { SEARCH_COMMANDS } from "./search-command"
import { SKILL_COMMANDS } from "./skill-commands"
import { VIEW_COMMANDS } from "./view-commands"

let registered = false

export function registerFeatureCommands(): void {
  if (registered) return
  registered = true
  registerCommands([
    ...COGNIA_COMMANDS,
    ...MCP_COMMANDS,
    ...SKILL_COMMANDS,
    ...PLUGIN_COMMANDS,
    ...VIEW_COMMANDS,
    ...PARITY_COMMANDS,
    ...SEARCH_COMMANDS,
    ...EXPAND_COMMANDS,
    ...INSPECT_COMMANDS,
    ...KEYBIND_COMMANDS,
    // `/menu` lives here (not in CORE_COMMANDS) because the command-palette it
    // builds reads the registry — registering it in core would form an import
    // cycle (registry → menu-command → build-command-palette → registry).
    menuCommand,
  ])
}

/** Test-only: allow re-registration after a registry reset. */
export function __resetFeatureRegistrationForTesting(): void {
  registered = false
}

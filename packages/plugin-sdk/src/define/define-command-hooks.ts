/**
 * Plugin SDK helper for the `command-hooks` capability.
 *
 * Pure typesafety pass-through — wrapping a manifest `commandHooks` block in
 * `defineCommandHooks()` gives plugin authors autocomplete and a compile-time
 * check that the block matches the `settings.json` `hooks` shape every hook
 * runner already executes (`Event → HookGroup[]`). The block is declarative:
 * handlers run in the hook runtime, not inside the plugin sandbox, so the
 * capability must be declared in `capabilities` for the block to be merged.
 *
 * Usage:
 *   const commandHooks = defineCommandHooks({
 *     PreToolUse: [
 *       {
 *         matcher: "Bash",
 *         hooks: [
 *           {
 *             type: "command",
 *             command: "node ${COGNIA_PLUGIN_ROOT}/hooks/guard.mjs",
 *             timeout: 5,
 *           },
 *         ],
 *       },
 *     ],
 *   })
 */

import type { HooksConfig } from "@/lib/claude/hooks"

export function defineCommandHooks(config: HooksConfig): HooksConfig {
  return config
}

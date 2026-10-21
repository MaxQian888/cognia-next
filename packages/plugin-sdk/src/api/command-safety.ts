/**
 * Plugin SDK — `command-safety` capability surface.
 *
 * Re-exports plugin command-rule registry helpers and the deterministic
 * command classifier used by terminal Auto-mode safety checks.
 */

export {
  getPluginCommandRulesets,
  registerPluginCommandRules,
  unregisterPluginCommandRules,
} from "@/lib/plugin/registries/command-safety-registry"

export { classifyCommand as classifyCommandSafety } from "@cognia/plugin-contract/lib/claude/permissions/command-safety"

export type {
  CommandClassification,
  CommandVerdict,
  SegmentClassification,
} from "@cognia/plugin-contract/lib/claude/permissions/command-safety"

export type {
  PermissionVerdict,
  ResolvedPermission,
  ResolveOptions,
  Ruleset,
  ToolRules,
} from "@cognia/plugin-contract/lib/claude/permissions/ruleset"

export type {
  PluginCommandClassification,
  PluginCommandRule,
} from "@cognia/plugin-contract/lib/plugin/api/terminal-api"

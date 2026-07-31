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

export { classifyCommand as classifyCommandSafety } from "@/lib/claude/permissions/command-safety"

export type {
  CommandClassification,
  CommandVerdict,
  SegmentClassification,
} from "@/lib/claude/permissions/command-safety"

export type {
  PermissionVerdict,
  ResolvedPermission,
  ResolveOptions,
  Ruleset,
  ToolRules,
} from "@/lib/claude/permissions/ruleset"

export type { PluginCommandClassification, PluginCommandRule } from "@/lib/plugin/api/terminal-api"

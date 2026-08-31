import type { PluginDefinition } from "@/types/plugin/plugin"

/** Preserve a plugin definition while giving TypeScript the complete author contract. */
export function definePlugin(definition: PluginDefinition): PluginDefinition {
  return definition
}

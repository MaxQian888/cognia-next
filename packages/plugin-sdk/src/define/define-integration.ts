import type { PluginIntegrationDef } from "@cognia/plugin-contract/types/plugin/plugin-integration"

/** Preserve literal ids while validating a declarative Integration contribution. */
export function defineIntegration<const T extends PluginIntegrationDef>(definition: T): T {
  return definition
}

import type { PluginExtensionDef } from "@cognia/plugin-contract/types/plugin/plugin-extension"

/** Preserve literal extension metadata while validating the public manifest shape. */
export function defineExtension<const T extends PluginExtensionDef>(extension: T): T {
  return extension
}

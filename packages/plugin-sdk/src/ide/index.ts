import type { PluginIdeManifest } from "@cognia/plugin-contract/types/plugin/plugin-ide"

export type * from "@cognia/plugin-contract/types/plugin/plugin-ide"

/** Define a stable IDE manifest block while preserving literal inference. */
export function defineIdeManifest<const T extends PluginIdeManifest>(manifest: T): T {
  return manifest
}

export * from "./generated"

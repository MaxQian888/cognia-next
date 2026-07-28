import type { PluginIdeManifest } from "@/types/plugin/plugin-ide"

export type * from "@/types/plugin/plugin-ide"

/** Define a stable IDE manifest block while preserving literal inference. */
export function defineIdeManifest<const T extends PluginIdeManifest>(manifest: T): T {
  return manifest
}

export * from "./generated"

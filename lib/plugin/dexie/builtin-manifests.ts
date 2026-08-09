import type { PluginManifestDexieBlock } from "@/types/plugin"

import strixManifest from "@/plugins/strix-security/plugin.json"
import zhihuManifest from "@/plugins/zhihu-content-pipeline/plugin.json"

interface ManifestWithDexie {
  id: string
  dexie?: PluginManifestDexieBlock
}

const manifests = [strixManifest, zhihuManifest] as ManifestWithDexie[]

/** Manifest-only registry used during database boot; imports no plugin code. */
export function getBuiltinPluginDexieManifests(): Map<string, PluginManifestDexieBlock> {
  return new Map(
    manifests
      .filter((manifest): manifest is ManifestWithDexie & { dexie: PluginManifestDexieBlock } =>
        Boolean(manifest.dexie)
      )
      .map((manifest) => [manifest.id, manifest.dexie])
  )
}

import type { PluginManifestDexieBlock } from "@/types/plugin"

import sreAgentManifest from "@/plugins/sre-agent/plugin.json"
import strixManifest from "@/plugins/strix-security/plugin.json"
import zhihuManifest from "@/plugins/zhihu-content-pipeline/plugin.json"

interface ManifestWithDexie {
  id: string
  dexie?: PluginManifestDexieBlock
}

/**
 * Every bundled plugin that declares `dexie.tables`.
 *
 * Hand-maintained, and the failure mode is quiet: a plugin whose tables are
 * declared but whose manifest is missing here boots with no table applied to
 * the schema, and its first `ctx.dexie.table(...)` call throws a Dexie lookup
 * error at runtime rather than at boot. `builtin-manifests.test.ts` walks
 * `plugins/` to keep the two in step.
 */
const manifests = [sreAgentManifest, strixManifest, zhihuManifest] as ManifestWithDexie[]

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

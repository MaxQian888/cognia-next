import type { VendorRoots } from "@/lib/agent-roots"
import { probeRootKeysForMigrationVendor } from "@/lib/agent-ecosystem/catalog"
import { MIGRATION_VENDORS, type MigrationVendor, type MigrationVendorProbe } from "./types"

export interface ProbeVendorsDeps {
  roots: () => Promise<VendorRoots>
  exists: (path: string) => Promise<boolean>
  readAgentConfig: (vendor: MigrationVendor) => Promise<{ exists: boolean; path: string | null }>
}

async function defaultDeps(): Promise<ProbeVendorsDeps> {
  const [{ resolveVendorRoots }, { exists }, { readAgentConfig }] = await Promise.all([
    import("@/lib/agent-roots"),
    import("@/lib/file/file-operations"),
    import("@/lib/claude/ipc"),
  ])
  return { roots: resolveVendorRoots, exists, readAgentConfig }
}

export async function probeVendors(deps?: ProbeVendorsDeps): Promise<MigrationVendorProbe[]> {
  const resolved = deps ?? (await defaultDeps())
  const roots = await resolved.roots()
  // The catalog's `probeRootKeys` are ordered and the first non-empty one wins,
  // which is how OpenCode keeps preferring its data directory over its config
  // directory. That preference used to be a `||` in a hand-written map.
  const rootFor = (vendor: MigrationVendor): string => {
    const keys = probeRootKeysForMigrationVendor(vendor)
    const values = roots as unknown as Record<string, string | undefined>
    for (const key of keys) {
      const value = values[key]
      if (value) return value
    }
    return ""
  }
  return Promise.all(
    MIGRATION_VENDORS.map(async (vendor) => {
      let config: { exists: boolean; path: string | null } = { exists: false, path: null }
      try {
        config = await resolved.readAgentConfig(vendor)
      } catch {
        // Directory probe still identifies installs whose config is absent.
      }
      const root = rootFor(vendor)
      const rootExists = root ? await resolved.exists(root).catch(() => false) : false
      return {
        vendor,
        installed: config.exists || rootExists,
        ...(config.path ? { configPath: config.path } : {}),
      }
    })
  )
}

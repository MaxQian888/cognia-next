import type { VendorRoots } from "@/lib/agent-roots"
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
  const rootFor: Record<MigrationVendor, string> = {
    "claude-code": roots.claudeConfigDir,
    codex: roots.codexHome,
    opencode: roots.opencodeDataDir || roots.opencodeConfigDir,
    pi: roots.piAgentDir,
  }
  return Promise.all(
    MIGRATION_VENDORS.map(async (vendor) => {
      let config: { exists: boolean; path: string | null } = { exists: false, path: null }
      try {
        config = await resolved.readAgentConfig(vendor)
      } catch {
        // Directory probe still identifies installs whose config is absent.
      }
      const root = rootFor[vendor]
      const rootExists = root ? await resolved.exists(root).catch(() => false) : false
      return {
        vendor,
        installed: config.exists || rootExists,
        ...(config.path ? { configPath: config.path } : {}),
      }
    })
  )
}

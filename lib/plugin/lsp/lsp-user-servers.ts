/**
 * Bootstrap for the editor-side LSP servers fed from the unified resolver
 * (`lib/lsp/resolve-config.ts`). Takes the resolved server list (builtin ←
 * user ← project layers), keeps only the entries the editor should run, and
 * converges the registry's `"user"`-owned records to match. Safe to call any
 * number of times — it always re-syncs against the latest input.
 *
 * Which servers run in the editor: user-added servers, project `.cognia/
 * lsp.json` servers, and builtins the user/project explicitly overrode. PURE
 * builtin defaults (source `"builtin"`, never overridden) stay agent-only —
 * the editor registry spawns eagerly on register, so auto-starting four
 * toolchains the user never asked for would surface noisy "crashed" states
 * for uninstalled binaries. The agent runtime starts builtins lazily + PATH-
 * probed, so it owns them without that cost. See `editorEligibleServers`.
 *
 * The "user" pluginPath is a synthetic absolute path under the cognia app
 * data dir (`<app_data>/cognia/user-lsp/`) — the LSP binary policy uses it
 * for the inside-dir check. Real user-installed binaries almost always live
 * outside that path, which forces a prompt — that's the intended trust model.
 */

import type { LspServerConfig, ResolvedLspServer } from "@/types/lsp/config"
import type { PluginLspServerDef } from "@/types/plugin"
import { listLspServers, registerLspServer, unregisterLspServer } from "./lsp-registry"

const USER_OWNER = "user"
/** Synthetic pluginPath the binary policy uses for the inside-dir check. */
export const USER_LSP_PLUGIN_PATH = "<app_data>/cognia/user-lsp"

/**
 * From a fully-resolved server list, keep the ones the editor should spawn:
 * everything except pure builtin defaults (a builtin a user/project overrode
 * has `source` `"user"` / `"project"`, so it survives). Disabled entries are
 * already dropped by the resolver.
 */
export function editorEligibleServers(resolved: ResolvedLspServer[]): ResolvedLspServer[] {
  return resolved.filter((s) => s.source !== "builtin")
}

/**
 * Apply a resolved server list to the registry. Adds new entries, removes
 * entries that no longer appear, and re-applies existing ones whose `enabled`
 * flag flipped from false → true.
 *
 * `confirmedConsent` is set to `true` for every entry — the user (or their
 * project config) explicitly declared the binary, a more deliberate act than
 * installing a third-party `.vsix`. The dev-mode toggle remains the escape
 * hatch for unsigned `.vsix` LSPs (Phase A).
 */
export async function syncUserLspServers(
  entries: LspServerConfig[] | undefined
): Promise<{ added: number; removed: number; skipped: number }> {
  const desired = (entries ?? []).filter((e) => e.enabled !== false)
  const desiredById = new Map(desired.map((e) => [e.id, e] as const))
  const existing = listLspServers().filter((r) => r.ownerId === USER_OWNER)
  const existingById = new Map(existing.map((r) => [r.serverId, r] as const))

  let added = 0
  let removed = 0
  let skipped = 0

  // Remove entries no longer wanted (disabled or deleted).
  for (const rec of existing) {
    if (!desiredById.has(rec.serverId)) {
      await unregisterLspServer(USER_OWNER, rec.serverId)
      removed += 1
    }
  }

  // Add new entries.
  for (const entry of desired) {
    if (existingById.has(entry.id)) {
      skipped += 1
      continue
    }
    await registerLspServer({
      ownerId: USER_OWNER,
      config: toServerDef(entry),
      pluginPath: USER_LSP_PLUGIN_PATH,
      confirmedConsent: true,
    })
    added += 1
  }

  return { added, removed, skipped }
}

function toServerDef(entry: LspServerConfig): PluginLspServerDef {
  return {
    id: entry.id,
    name: entry.name,
    languages: entry.languages,
    extensions: entry.extensions,
    filenames: entry.filenames,
    command: entry.command,
    args: entry.args,
    env: entry.env,
    rootMarkers: entry.rootMarkers,
    excludeRootMarkers: entry.excludeRootMarkers,
    transport: entry.transport,
    initializationOptions: entry.initializationOptions,
    settings: entry.settings,
    workspaceFolderRequired: entry.workspaceFolderRequired,
  }
}

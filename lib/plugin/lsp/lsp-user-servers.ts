/**
 * Bootstrap for the user-managed LSP entries (Settings → Language
 * Servers, Phase B). Reads `AppSettings.developer.userLspServers`,
 * diffs against the registry's currently-registered `"user"` records,
 * and applies `register` / `unregister` to converge. Safe to call any
 * number of times — it always re-syncs against the latest settings.
 *
 * The "user" pluginPath is a synthetic absolute path under the cognia
 * app data dir (`<app_data>/cognia/user-lsp/`) — the LSP binary policy
 * uses it for the inside-dir check. Real user-installed binaries
 * almost always live outside that path, which forces a prompt — that's
 * the intended trust model.
 */

import type { UserLspServerEntry } from "@/lib/claude/types"
import type { PluginLspServerDef } from "@/types/plugin"
import { listLspServers, registerLspServer, unregisterLspServer } from "./lsp-registry"

const USER_OWNER = "user"
/** Synthetic pluginPath the binary policy uses for the inside-dir check. */
export const USER_LSP_PLUGIN_PATH = "<app_data>/cognia/user-lsp"

/**
 * Apply a settings-shaped list of entries to the registry. Adds new
 * entries, removes entries that no longer appear, and re-applies
 * existing ones whose `enabled` flag flipped from false → true.
 *
 * `confirmedConsent` is set to `true` for every user-added entry — the
 * user explicitly added the binary to their settings, which is a more
 * deliberate act than installing a third-party `.vsix`. The dev-mode
 * toggle remains the escape hatch for unsigned `.vsix` LSPs (Phase A).
 */
export async function syncUserLspServers(
  entries: UserLspServerEntry[] | undefined
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

function toServerDef(entry: UserLspServerEntry): PluginLspServerDef {
  return {
    id: entry.id,
    name: entry.name,
    languages: entry.languages,
    command: entry.command,
    args: entry.args,
    env: entry.env,
    transport: entry.transport,
    initializationOptions: entry.initializationOptions,
    settings: entry.settings,
    workspaceFolderRequired: entry.workspaceFolderRequired,
  }
}

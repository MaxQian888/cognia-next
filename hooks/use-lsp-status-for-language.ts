"use client"

/**
 * Resolve which configured LSP server owns a Monaco language id and surface
 * its live status from the LSP status store. Drives the editor's
 * missing/broken server hint.
 *
 * Server selection is a synchronous merge of the builtin defaults with the
 * user layer (`settings.lsp.servers`): a same-id user entry overrides the
 * builtin (including `enabled: false` removal), and custom user servers are
 * considered after builtins. Project-layer (`.cognia/lsp.json`) overrides are
 * ignored here — the hint is advisory and the project layer can only ADD
 * servers, which the status store still reports by id.
 *
 * On web/mobile the status store stays inert (empty statuses) so the hook
 * returns `status: undefined` and consumers render nothing.
 */

import { useEffect, useMemo } from "react"
import type { LspServerConfig, LspServerStatus } from "@/types/lsp/config"
import { BUILTIN_LSP_SERVERS } from "@/lib/lsp/builtin-defaults"
import { useLspStatusStore } from "@/lib/lsp/lsp-status-store"
import { useSettingsStore } from "@/stores/settings/settings-store"

export interface LspLanguageStatus {
  serverId: string
  /** Undefined until the status store has refreshed (or off-Tauri). */
  status?: LspServerStatus
}

/** First enabled server (builtin merged with user layer) for a language. */
export function serverForLanguage(
  languageId: string,
  userServers: readonly LspServerConfig[] | undefined
): LspServerConfig | null {
  const users = userServers ?? []
  const userById = new Map(users.map((s) => [s.id, s] as const))
  for (const builtin of BUILTIN_LSP_SERVERS) {
    const override = userById.get(builtin.id)
    const effective = override ? { ...builtin, ...override } : builtin
    if (effective.enabled === false) continue
    if (effective.languages.includes(languageId)) return effective
  }
  for (const user of users) {
    if (user.enabled === false) continue
    if (userById.get(user.id) && BUILTIN_LSP_SERVERS.some((b) => b.id === user.id)) continue
    if (user.languages.includes(languageId)) return user
  }
  return null
}

export function useLspStatusForLanguage(languageId: string): LspLanguageStatus | null {
  const userServers = useSettingsStore((s) => s.settings?.lsp?.servers)
  const statuses = useLspStatusStore((s) => s.statuses)
  const refresh = useLspStatusStore((s) => s.refresh)

  // Make sure the store has a snapshot even when Settings was never opened.
  // Inert (no RPC) on web/mobile.
  useEffect(() => {
    if (Object.keys(useLspStatusStore.getState().statuses).length === 0) {
      void refresh()
    }
  }, [refresh])

  return useMemo(() => {
    const server = serverForLanguage(languageId, userServers)
    if (!server) return null
    return { serverId: server.id, status: statuses[server.id] }
  }, [languageId, userServers, statuses])
}

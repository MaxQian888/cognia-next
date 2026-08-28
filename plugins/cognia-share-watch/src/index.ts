/**
 * Share Watch — built-in reference plugin for the public-share-link hooks.
 *
 * Returns a `hooks` block from activate() (the manager captures the return
 * value) that records every share link created or revoked. The create payload
 * carries only the fragment-stripped URL, so this demo can never observe the
 * `#k=` decryption key (zero-knowledge red-line, ADR-0037).
 */

import type { PluginContext, PluginDefinition } from "@cognia/plugin-sdk"
import type { PluginHooksAll, ShareLinkHookPayload } from "@cognia/plugin-sdk"
import manifest from "../plugin.json"

interface ShareWatchEntry {
  kind: "created" | "revoked"
  code: string
  url?: string
}

const log: ShareWatchEntry[] = []

/** Test/inspection accessor — the recorded share-link log. */
export function getShareWatchLog(): readonly ShareWatchEntry[] {
  return log
}

/** Test-only reset. */
export function __resetShareWatchForTesting(): void {
  log.length = 0
}

const hooks: PluginHooksAll = {
  onShareLinkCreate: (link: ShareLinkHookPayload) =>
    void log.push({ kind: "created", code: link.code, url: link.url }),
  onShareLinkRevoke: (code: string) => void log.push({ kind: "revoked", code }),
}

const definition: PluginDefinition = {
  manifest: manifest as never,
  activate: async (ctx: PluginContext) => {
    ctx.logger?.info("share-watch activated (listening for share-link hooks)")
    return hooks
  },
  deactivate: async (ctx?: PluginContext) => {
    ctx?.logger?.info("share-watch deactivated")
  },
}

export default definition

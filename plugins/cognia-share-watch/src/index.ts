/**
 * Share Watch — opt-in EXAMPLE plugin for the public-share-link hooks.
 *
 * Author reference material, labelled that way on all three axes:
 *   - documented here and at {@link SHARE_WATCH_EXAMPLE};
 *   - labelled in the UI: the plugin's name and description say "(example)"
 *     and that it adds no UI;
 *   - pinned by `index.test.ts` (no `startup` activation, no UI contribution).
 *
 * The host offers no share-scoped extension point for a panel, so the
 * example's observable effect is one line per event in this plugin's log
 * (Plugins → Share Watch → Logs). The create payload carries only the
 * fragment-stripped URL, so the example can never observe the `#k=` decryption
 * key (zero-knowledge red-line, ADR-0037). Nothing is kept in memory.
 */

import {
  definePlugin,
  definePluginManifest,
  type PluginContext,
  type PluginHooksAll,
  type ShareLinkHookPayload,
} from "@cognia/plugin-sdk"
import manifestJson from "../plugin.json"

/**
 * Marker for the plugin's status: an example that demonstrates the share-link
 * hooks and contributes no UI. Pinned by the tests.
 */
export const SHARE_WATCH_EXAMPLE = {
  example: true,
  surface: "plugin-log",
} as const

export const manifest = definePluginManifest(manifestJson)

/** Defence in depth: never let a key fragment reach the log, whatever the host sends. */
function withoutFragment(url: string): string {
  const hash = url.indexOf("#")
  return hash === -1 ? url : url.slice(0, hash)
}

/** The hook block, bound to the activation's logger. */
export function createShareWatchHooks(logger: PluginContext["logger"]): PluginHooksAll {
  return {
    onShareLinkCreate: (link: ShareLinkHookPayload) => {
      logger.info(
        `share link created: ${link.code} (${link.kind}) ${link.url ? withoutFragment(link.url) : ""}`.trim()
      )
    },
    onShareLinkRevoke: (code: string) => {
      logger.info(`share link revoked: ${code}`)
    },
  }
}

export default definePlugin({
  manifest,
  activate: async (ctx: PluginContext) => createShareWatchHooks(ctx.logger),
})

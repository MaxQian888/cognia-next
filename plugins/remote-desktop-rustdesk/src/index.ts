/**
 * First-party RustDesk provider (ADR-0234 Phase 5). It names the Host's
 * `rustdesk` launcher; the Host builds the only link form Cognia opens
 * (`rustdesk://connection/new/<id>`), and the client re-checks it before
 * handing it to the installed app. No password is ever stored or passed.
 */

import type { PluginContext, PluginDefinition } from "@cognia/plugin-sdk"
import { definePlugin, definePluginManifest, defineRemoteDesktopProvider } from "@cognia/plugin-sdk"

import manifestJson from "../plugin.json"
import { PROVIDER_ID } from "./ids"

export const manifest = definePluginManifest(manifestJson)

export function rustdeskProvider(ctx: Pick<PluginContext, "i18n">) {
  return defineRemoteDesktopProvider({
    id: PROVIDER_ID,
    name: ctx.i18n.t("provider.name"),
    description: ctx.i18n.t("provider.description"),
    integrationMode: "external-app",
    launcher: "rustdesk",
  })
}

export function createRemoteDesktopRustdeskPlugin(): PluginDefinition {
  let dispose: (() => void) | undefined
  return definePlugin({
    manifest,
    activate: (ctx) => {
      dispose?.()
      dispose = undefined
      if (!ctx.remoteDesktop) {
        ctx.logger.warn("ctx.remoteDesktop is unavailable; the RustDesk provider is not registered")
        return
      }
      dispose = ctx.remoteDesktop.registerProvider(rustdeskProvider(ctx))
    },
    deactivate: () => {
      dispose?.()
      dispose = undefined
    },
  })
}

export default createRemoteDesktopRustdeskPlugin()

/**
 * First-party VNC provider (ADR-0234 Phase 2). Registers through
 * `ctx.remoteDesktop`, the same `provider.remote-desktop` point any plugin
 * uses; being built in only lets it render a React viewer in the app.
 */

import type { PluginContext, PluginDefinition } from "@cognia/plugin-sdk"
import { definePlugin, definePluginManifest, defineRemoteDesktopProvider } from "@cognia/plugin-sdk"

import manifestJson from "../plugin.json"
import { PROVIDER_ID } from "./ids"
import { VncViewer } from "./vnc-viewer"

export const manifest = definePluginManifest(manifestJson)

export function vncProvider(ctx: Pick<PluginContext, "i18n">) {
  return defineRemoteDesktopProvider({
    id: PROVIDER_ID,
    name: ctx.i18n.t("provider.name"),
    description: ctx.i18n.t("provider.description"),
    integrationMode: "embedded",
    adapter: "vnc",
    defaultPort: 5900,
    // TigerVNC (vncpasswd) and x11vnc (-viewpasswd) enforce a view password.
    capabilities: { viewOnlyPassword: true },
    viewer: { kind: "react", component: VncViewer },
  })
}

export function createRemoteDesktopVncPlugin(): PluginDefinition {
  let dispose: (() => void) | undefined
  return definePlugin({
    manifest,
    activate: (ctx) => {
      dispose?.()
      dispose = undefined
      if (!ctx.remoteDesktop) {
        ctx.logger.warn("ctx.remoteDesktop is unavailable; the VNC provider is not registered")
        return
      }
      dispose = ctx.remoteDesktop.registerProvider(vncProvider(ctx))
    },
    deactivate: () => {
      dispose?.()
      dispose = undefined
    },
  })
}

export default createRemoteDesktopVncPlugin()

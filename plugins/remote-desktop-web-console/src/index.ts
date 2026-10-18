/**
 * First-party web console providers (ADR-0234 Phase 5): Apache Guacamole and
 * MeshCentral. Each names a console profile from the Host's closed list; the
 * Host checks the pasted link with it and the client opens the page in an
 * isolated webview or a browser. Neither sees a console credential.
 */

import type { PluginContext, PluginDefinition } from "@cognia/plugin-sdk"
import { definePlugin, definePluginManifest, defineRemoteDesktopProvider } from "@cognia/plugin-sdk"

import manifestJson from "../plugin.json"
import { GUACAMOLE_PROVIDER_ID, MESHCENTRAL_PROVIDER_ID } from "./ids"

export const manifest = definePluginManifest(manifestJson)

export function consoleProviders(ctx: Pick<PluginContext, "i18n">) {
  return [
    defineRemoteDesktopProvider({
      id: GUACAMOLE_PROVIDER_ID,
      name: ctx.i18n.t("guacamole.name"),
      description: ctx.i18n.t("guacamole.description"),
      integrationMode: "web-console",
      consoleProfile: "guacamole",
      linkExample: ctx.i18n.t("guacamole.example"),
    }),
    defineRemoteDesktopProvider({
      id: MESHCENTRAL_PROVIDER_ID,
      name: ctx.i18n.t("meshcentral.name"),
      description: ctx.i18n.t("meshcentral.description"),
      integrationMode: "web-console",
      consoleProfile: "meshcentral",
      linkExample: ctx.i18n.t("meshcentral.example"),
    }),
  ]
}

export function createRemoteDesktopWebConsolePlugin(): PluginDefinition {
  let disposers: Array<() => void> = []
  const dispose = () => {
    for (const disposer of disposers) disposer()
    disposers = []
  }
  return definePlugin({
    manifest,
    activate: (ctx) => {
      dispose()
      if (!ctx.remoteDesktop) {
        ctx.logger.warn(
          "ctx.remoteDesktop is unavailable; the web console providers are not registered"
        )
        return
      }
      const remoteDesktop = ctx.remoteDesktop
      disposers = consoleProviders(ctx).map((provider) => remoteDesktop.registerProvider(provider))
    },
    deactivate: dispose,
  })
}

export default createRemoteDesktopWebConsolePlugin()

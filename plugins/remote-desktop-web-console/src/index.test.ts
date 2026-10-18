import type { PluginContext } from "@cognia/plugin-sdk"
import { findPluginManifestParityIssues } from "@cognia/plugin-sdk/manifest"

import packagedManifest from "../plugin.json"
import { PLUGIN_ID } from "./ids"
import defaultPlugin, {
  consoleProviders,
  createRemoteDesktopWebConsolePlugin,
  manifest,
} from "./index"

function makeCtx(registerProvider?: jest.Mock) {
  const en = packagedManifest.i18n.locales.en as Record<string, string>
  return {
    i18n: { t: (key: string) => en[key] ?? key },
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
    remoteDesktop: registerProvider ? { registerProvider } : undefined,
  } as unknown as PluginContext
}

describe("remote-desktop-web-console plugin", () => {
  it("ships a manifest that matches its package and asks only to provide", () => {
    expect(manifest.id).toBe(PLUGIN_ID)
    expect(packagedManifest.permissions).toEqual(["remote-desktop:provide"])
    expect(findPluginManifestParityIssues(manifest, packagedManifest as never)).toEqual([])
    expect(defaultPlugin.manifest.id).toBe(manifest.id)
    const zh = packagedManifest.i18n.locales["zh-CN"] as Record<string, string>
    expect(Object.keys(zh).sort()).toEqual(Object.keys(packagedManifest.i18n.locales.en).sort())
  })

  it("describes Guacamole and MeshCentral as web consoles with their link profiles", () => {
    expect(consoleProviders(makeCtx())).toEqual([
      expect.objectContaining({
        id: "guacamole",
        name: "Apache Guacamole",
        integrationMode: "web-console",
        consoleProfile: "guacamole",
        linkExample: "https://gateway.example.com/guacamole/#/client/…",
      }),
      expect.objectContaining({
        id: "meshcentral",
        name: "MeshCentral",
        integrationMode: "web-console",
        consoleProfile: "meshcentral",
      }),
    ])
  })

  it("registers both providers per activation and disposes them on deactivate", () => {
    const dispose = jest.fn()
    const registerProvider = jest.fn(() => dispose)
    const plugin = createRemoteDesktopWebConsolePlugin()
    const ctx = makeCtx(registerProvider)
    plugin.activate?.(ctx)
    plugin.activate?.(ctx)
    expect(registerProvider).toHaveBeenCalledTimes(4)
    // Re-activation unwinds the previous registrations first.
    expect(dispose).toHaveBeenCalledTimes(2)
    plugin.deactivate?.(ctx)
    expect(dispose).toHaveBeenCalledTimes(4)
  })

  it("warns instead of throwing on a host without ctx.remoteDesktop", () => {
    const ctx = makeCtx()
    createRemoteDesktopWebConsolePlugin().activate?.(ctx)
    expect(ctx.logger.warn).toHaveBeenCalled()
  })
})

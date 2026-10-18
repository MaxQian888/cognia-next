import type { PluginContext } from "@cognia/plugin-sdk"
import { findPluginManifestParityIssues } from "@cognia/plugin-sdk/manifest"

import packagedManifest from "../plugin.json"
import { PLUGIN_ID } from "./ids"
import defaultPlugin, {
  createRemoteDesktopRustdeskPlugin,
  manifest,
  rustdeskProvider,
} from "./index"

function makeCtx(registerProvider?: jest.Mock) {
  const en = packagedManifest.i18n.locales.en as Record<string, string>
  return {
    i18n: { t: (key: string) => en[key] ?? key },
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
    remoteDesktop: registerProvider ? { registerProvider } : undefined,
  } as unknown as PluginContext
}

describe("remote-desktop-rustdesk plugin", () => {
  it("ships a manifest that matches its package and asks only to provide", () => {
    expect(manifest.id).toBe(PLUGIN_ID)
    expect(packagedManifest.permissions).toEqual(["remote-desktop:provide"])
    expect(findPluginManifestParityIssues(manifest, packagedManifest as never)).toEqual([])
    expect(defaultPlugin.manifest.id).toBe(manifest.id)
    expect(Object.keys(packagedManifest.i18n.locales["zh-CN"]).sort()).toEqual(
      Object.keys(packagedManifest.i18n.locales.en).sort()
    )
  })

  it("names the closed rustdesk launcher and nothing that could build a link", () => {
    expect(rustdeskProvider(makeCtx())).toEqual({
      id: "rustdesk",
      name: "RustDesk",
      description: "A RustDesk ID, opened in the RustDesk app on this device.",
      integrationMode: "external-app",
      launcher: "rustdesk",
    })
  })

  it("registers once per activation and disposes on deactivate", () => {
    const dispose = jest.fn()
    const registerProvider = jest.fn(() => dispose)
    const plugin = createRemoteDesktopRustdeskPlugin()
    const ctx = makeCtx(registerProvider)
    plugin.activate?.(ctx)
    plugin.activate?.(ctx)
    expect(registerProvider).toHaveBeenCalledTimes(2)
    expect(dispose).toHaveBeenCalledTimes(1)
    plugin.deactivate?.(ctx)
    expect(dispose).toHaveBeenCalledTimes(2)
  })

  it("warns instead of throwing on a host without ctx.remoteDesktop", () => {
    const ctx = makeCtx()
    createRemoteDesktopRustdeskPlugin().activate?.(ctx)
    expect(ctx.logger.warn).toHaveBeenCalled()
  })
})

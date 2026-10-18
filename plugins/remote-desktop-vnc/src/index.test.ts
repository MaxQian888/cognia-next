import type { PluginContext } from "@cognia/plugin-sdk"
import { findPluginManifestParityIssues } from "@cognia/plugin-sdk/manifest"

jest.mock("./vnc-viewer", () => ({ VncViewer: () => null }))

import packagedManifest from "../plugin.json"
import defaultPlugin, { createRemoteDesktopVncPlugin, manifest, vncProvider } from "./index"
import { VncViewer } from "./vnc-viewer"

function makeCtx(registerProvider?: jest.Mock) {
  const en = packagedManifest.i18n.locales.en as Record<string, string>
  return {
    i18n: { t: (key: string) => en[key] ?? key },
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
    remoteDesktop: registerProvider ? { registerProvider } : undefined,
  } as unknown as PluginContext
}

describe("remote-desktop-vnc plugin", () => {
  it("ships a manifest that matches its package and asks only to provide", () => {
    expect(manifest.id).toBe("cognia-remote-desktop-vnc")
    expect(packagedManifest.permissions).toEqual(["remote-desktop:provide"])
    expect(findPluginManifestParityIssues(manifest, packagedManifest as never)).toEqual([])
    expect(defaultPlugin.manifest.id).toBe(manifest.id)
  })

  it("describes an embedded VNC provider with a server-enforced view-only option", () => {
    const provider = vncProvider(makeCtx())
    expect(provider).toMatchObject({
      id: "vnc",
      name: "VNC",
      integrationMode: "embedded",
      adapter: "vnc",
      defaultPort: 5900,
      capabilities: { viewOnlyPassword: true },
      viewer: { kind: "react", component: VncViewer },
    })
  })

  it("registers once per activation and disposes on deactivate", () => {
    const dispose = jest.fn()
    const registerProvider = jest.fn(() => dispose)
    const plugin = createRemoteDesktopVncPlugin()
    const ctx = makeCtx(registerProvider)
    plugin.activate?.(ctx)
    plugin.activate?.(ctx)
    expect(registerProvider).toHaveBeenCalledTimes(2)
    // Re-activation unwinds the previous registration first.
    expect(dispose).toHaveBeenCalledTimes(1)
    plugin.deactivate?.(ctx)
    expect(dispose).toHaveBeenCalledTimes(2)
  })

  it("warns instead of throwing on a host without ctx.remoteDesktop", () => {
    const ctx = makeCtx()
    createRemoteDesktopVncPlugin().activate?.(ctx)
    expect(ctx.logger.warn).toHaveBeenCalled()
  })
})

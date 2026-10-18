import {
  __resetRemoteDesktopProvidersForTests,
  getRemoteDesktopProvider,
  unregisterRemoteDesktopProvidersOf,
  type RemoteDesktopProviderDefinition,
} from "@/lib/remote-desktop/provider-registry"

import { createRemoteDesktopAPI } from "./remote-desktop-api"

const definition: RemoteDesktopProviderDefinition = {
  id: "vnc",
  name: "VNC",
  integrationMode: "embedded",
  adapter: "vnc",
  defaultPort: 5900,
  capabilities: { viewOnlyPassword: true },
  viewer: { kind: "react", component: () => null },
}

afterEach(() => __resetRemoteDesktopProvidersForTests())

describe("ctx.remoteDesktop", () => {
  it("needs the remote-desktop:provide permission", () => {
    const api = createRemoteDesktopAPI("acme", { hasPermission: () => false, firstParty: true })
    expect(() => api.registerProvider(definition)).toThrow(/remote-desktop:provide/)
    expect(getRemoteDesktopProvider("acme.vnc")).toBeUndefined()
  })

  it("prefixes the id with the plugin and records whether it is first-party", () => {
    const api = createRemoteDesktopAPI("Cognia-Remote-Desktop-VNC", {
      hasPermission: (permission) => permission === "remote-desktop:provide",
      firstParty: true,
    })
    const dispose = api.registerProvider(definition)
    const registration = getRemoteDesktopProvider("cognia-remote-desktop-vnc.vnc")
    expect(registration).toMatchObject({ pluginId: "Cognia-Remote-Desktop-VNC", firstParty: true })
    dispose()
    expect(getRemoteDesktopProvider("cognia-remote-desktop-vnc.vnc")).toBeUndefined()
  })

  it("keeps a third-party plugin to a sandboxed webview viewer", () => {
    const api = createRemoteDesktopAPI("acme", { hasPermission: () => true, firstParty: false })
    expect(() => api.registerProvider(definition)).toThrow("remote_desktop_viewer_requires_webview")
    api.registerProvider({ ...definition, viewer: { kind: "webview", viewId: "viewer" } })
    expect(unregisterRemoteDesktopProvidersOf("acme")).toBe(1)
  })
})

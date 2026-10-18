import {
  __resetRemoteDesktopProvidersForTests,
  getRemoteDesktopProvider,
  IMPLEMENTED_INTEGRATION_MODES,
  listRemoteDesktopProviders,
  providerIdOf,
  registerRemoteDesktopProvider,
  subscribeRemoteDesktopProviders,
  unregisterRemoteDesktopProvidersOf,
  accessOfProvider,
  type RemoteDesktopEmbeddedProvider,
  type RemoteDesktopProviderDefinition,
  type RemoteDesktopProviderRegistration,
} from "./provider-registry"

const Viewer = () => null

function definition(
  overrides: Partial<RemoteDesktopEmbeddedProvider> = {}
): RemoteDesktopEmbeddedProvider {
  return {
    id: "vnc",
    name: "VNC",
    integrationMode: "embedded",
    adapter: "vnc",
    defaultPort: 5900,
    capabilities: { viewOnlyPassword: true },
    viewer: { kind: "react", component: Viewer },
    ...overrides,
  }
}

function registration(
  overrides: Partial<RemoteDesktopProviderRegistration> = {},
  def: Partial<RemoteDesktopEmbeddedProvider> = {}
): RemoteDesktopProviderRegistration {
  return {
    providerId: providerIdOf("cognia-remote-desktop-vnc", "vnc"),
    pluginId: "cognia-remote-desktop-vnc",
    firstParty: true,
    definition: definition(def),
    ...overrides,
  }
}

afterEach(() => __resetRemoteDesktopProvidersForTests())

describe("remote desktop provider registry", () => {
  it("registers, notifies and disposes a provider", () => {
    const listener = jest.fn()
    const unsubscribe = subscribeRemoteDesktopProviders(listener)
    const dispose = registerRemoteDesktopProvider(registration())
    expect(getRemoteDesktopProvider("cognia-remote-desktop-vnc.vnc")?.definition.name).toBe("VNC")
    const first = listRemoteDesktopProviders()
    expect(first).toHaveLength(1)
    // The snapshot is stable between changes, as useSyncExternalStore needs.
    expect(listRemoteDesktopProviders()).toBe(first)
    dispose()
    dispose()
    expect(listRemoteDesktopProviders()).toHaveLength(0)
    expect(listener).toHaveBeenCalledTimes(2)
    unsubscribe()
  })

  it("implements embedded, web console and external app providers, and refuses native by name", () => {
    expect(IMPLEMENTED_INTEGRATION_MODES).toEqual(["embedded", "web-console", "external-app"])
    const native = { id: "native", name: "Native", integrationMode: "native" } as const
    expect(() => registerRemoteDesktopProvider({ ...registration(), definition: native })).toThrow(
      "remote_desktop_integration_unavailable"
    )
  })

  it("lets any plugin register a web console, and external apps only through a closed launcher", () => {
    const consoleDef: RemoteDesktopProviderDefinition = {
      id: "guac",
      name: "Guacamole",
      integrationMode: "web-console",
      consoleProfile: "guacamole",
    }
    registerRemoteDesktopProvider({
      providerId: providerIdOf("acme", "guac"),
      pluginId: "acme",
      firstParty: false,
      definition: consoleDef,
    })
    expect(accessOfProvider(consoleDef)).toBe("web-console")
    expect(() =>
      registerRemoteDesktopProvider({
        providerId: providerIdOf("acme", "odd"),
        pluginId: "acme",
        firstParty: false,
        definition: { ...consoleDef, id: "odd", consoleProfile: "citrix" as never },
      })
    ).toThrow("remote_desktop_console_profile_unknown")
    const app: RemoteDesktopProviderDefinition = {
      id: "rd",
      name: "RustDesk",
      integrationMode: "external-app",
      launcher: "rustdesk",
    }
    registerRemoteDesktopProvider({
      providerId: providerIdOf("acme", "rd"),
      pluginId: "acme",
      firstParty: false,
      definition: app,
    })
    expect(accessOfProvider(app)).toBe("external-app")
    expect(() =>
      registerRemoteDesktopProvider({
        providerId: providerIdOf("acme", "anydesk"),
        pluginId: "acme",
        firstParty: false,
        definition: { ...app, id: "anydesk", launcher: "anydesk" as never },
      })
    ).toThrow("remote_desktop_launcher_unknown")
    expect(accessOfProvider(definition())).toBe("bridge")
    expect(accessOfProvider({ id: "n", name: "N", integrationMode: "native" })).toBeNull()
  })

  it("keeps React viewers to first-party plugins", () => {
    expect(() =>
      registerRemoteDesktopProvider(registration({ firstParty: false, pluginId: "acme" }))
    ).toThrow("remote_desktop_viewer_requires_webview")
    registerRemoteDesktopProvider(
      registration(
        { firstParty: false, pluginId: "acme", providerId: providerIdOf("acme", "vnc") },
        { viewer: { kind: "webview", viewId: "viewer" } }
      )
    )
    const registered = getRemoteDesktopProvider("acme.vnc")?.definition
    expect(registered?.integrationMode === "embedded" && registered.viewer.kind).toBe("webview")
    expect(() =>
      registerRemoteDesktopProvider(
        registration(
          { firstParty: false, pluginId: "acme", providerId: "acme.other" },
          { id: "other", viewer: { kind: "webview", viewId: "" } }
        )
      )
    ).toThrow("remote_desktop_viewer_invalid")
  })

  it("validates ids, adapters, ports and view-only claims", () => {
    expect(() => registerRemoteDesktopProvider(registration({ providerId: "Bad:Id" }))).toThrow(
      "remote_desktop_provider_id_invalid"
    )
    expect(() =>
      registerRemoteDesktopProvider(registration({}, { adapter: "rdp" as never }))
    ).toThrow("remote_desktop_adapter_unknown")
    expect(() => registerRemoteDesktopProvider(registration({}, { defaultPort: 0 }))).toThrow(
      "remote_desktop_provider_port_invalid"
    )
    expect(() =>
      registerRemoteDesktopProvider(
        registration({}, { adapter: "none", capabilities: { viewOnlyPassword: true } })
      )
    ).toThrow("remote_desktop_binding_cannot_be_read_only")
    registerRemoteDesktopProvider(registration())
    expect(() => registerRemoteDesktopProvider(registration())).toThrow(
      "remote_desktop_provider_duplicate"
    )
  })

  it("removes everything one plugin registered", () => {
    registerRemoteDesktopProvider(registration())
    registerRemoteDesktopProvider(
      registration(
        { providerId: "cognia-remote-desktop-vnc.raw" },
        { id: "raw", adapter: "none", capabilities: { viewOnlyPassword: false } }
      )
    )
    registerRemoteDesktopProvider(
      registration(
        { firstParty: false, pluginId: "acme", providerId: "acme.vnc" },
        { viewer: { kind: "webview", viewId: "v" } }
      )
    )
    expect(unregisterRemoteDesktopProvidersOf("cognia-remote-desktop-vnc")).toBe(2)
    expect(unregisterRemoteDesktopProvidersOf("cognia-remote-desktop-vnc")).toBe(0)
    expect(listRemoteDesktopProviders().map((entry) => entry.providerId)).toEqual(["acme.vnc"])
  })
})

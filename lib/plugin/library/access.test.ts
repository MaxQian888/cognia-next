import type { Plugin } from "@/types/plugin"
import { usePluginStore } from "@/stores/plugin-runtime"
import { getPermissionGuard } from "../security/permission-guard"
import { getPluginConsentBroker } from "../security/consent-broker"
import { assertLibraryAccess, authorizeLibraryAccess } from "./access"

jest.mock("@/stores/plugin-runtime", () => ({ usePluginStore: { getState: jest.fn() } }))
jest.mock("../security/consent-broker", () => ({
  getPluginConsentBroker: () => ({ request: mockConsent }),
}))
const mockConsent = jest.fn<Promise<boolean>, [unknown]>()

const provider = (): Plugin => ({
  manifest: {
    id: "library",
    name: "Library",
    description: "Library fixture",
    capabilities: ["library"],
    version: "1.2.0",
    type: "frontend",
    library: { rpc: {} },
  },
  status: "enabled",
  source: "local",
  path: "/plugins/library",
  config: {},
})

describe("library access", () => {
  let plugins: Record<string, Plugin>
  beforeEach(() => {
    plugins = {
      library: provider(),
      consumer: {
        source: "local",
        path: "/plugins/consumer",
        config: {},
        manifest: {
          id: "consumer",
          name: "Consumer",
          description: "Consumer fixture",
          capabilities: [],
          version: "1.0.0",
          type: "frontend",
          dependencies: { library: "^1.0.0" },
        },
        status: "loaded",
      },
    }
    jest
      .mocked(usePluginStore.getState)
      .mockReturnValue({ plugins } as ReturnType<typeof usePluginStore.getState>)
    const guard = getPermissionGuard()
    guard.registerPlugin("consumer", ["ipc:call", "filesystem:read"])
    guard.registerPlugin("library", ["ipc:expose", "filesystem:read"])
    mockConsent.mockReset()
  })

  it("accepts only a compatible required dependency", () => {
    expect(assertLibraryAccess("consumer", "library").provider).toBe(plugins.library)
    plugins.consumer.manifest.dependencies = { library: "^2.0.0" }
    expect(() => assertLibraryAccess("consumer", "library")).toThrow(
      "Compatible required dependency"
    )
    delete plugins.consumer.manifest.dependencies
    plugins.consumer.manifest.optionalDependencies = { library: "*" }
    expect(() => assertLibraryAccess("consumer", "library")).toThrow(
      "Compatible required dependency"
    )
  })

  it("rejects unsupported runtimes and disabled libraries", () => {
    plugins.consumer.manifest.engines = { node: ">=26" }
    expect(() => assertLibraryAccess("consumer", "library")).toThrow("runtime")
    delete plugins.consumer.manifest.engines
    plugins.library.status = "disabled"
    expect(() => assertLibraryAccess("consumer", "library")).toThrow("not active")
  })

  it("requires independent grants and rechecks revocation", async () => {
    const check = await authorizeLibraryAccess(
      "consumer",
      "library",
      ["filesystem:read"],
      "rpc:read"
    )
    getPermissionGuard().revoke("library", "filesystem:read")
    expect(check).toThrow()
    await expect(
      authorizeLibraryAccess("consumer", "library", ["filesystem:read"], "rpc:read")
    ).rejects.toThrow()
  })

  it("rejects a provider replacement even when the new version satisfies the range", async () => {
    const check = await authorizeLibraryAccess("consumer", "library", [], "rpc:read")
    plugins.library = provider()
    expect(check).toThrow("changed")
  })

  it("does not call the broker for a missing permission", async () => {
    getPermissionGuard().revoke("consumer", "filesystem:read")
    await expect(
      authorizeLibraryAccess("consumer", "library", ["filesystem:read"], "rpc:read")
    ).rejects.toThrow()
    expect(getPluginConsentBroker().request).not.toHaveBeenCalled()
  })

  it("fails explicitly when confirm-tier consent has no interactive host", async () => {
    getPermissionGuard().setTier("consumer", "filesystem:read", "confirm")
    await expect(
      authorizeLibraryAccess("consumer", "library", ["filesystem:read"], "rpc:read")
    ).rejects.toThrow("unavailable on this host")
    expect(mockConsent).not.toHaveBeenCalled()
  })

  it("rechecks both principals after consent resolves", async () => {
    Object.defineProperty(globalThis, "window", { value: {}, configurable: true })
    try {
      const guard = getPermissionGuard()
      guard.setTier("consumer", "filesystem:read", "confirm")
      mockConsent.mockImplementation(async () => {
        guard.revoke("library", "filesystem:read")
        return true
      })
      await expect(
        authorizeLibraryAccess("consumer", "library", ["filesystem:read"], "rpc:read")
      ).rejects.toThrow()
      expect(mockConsent).toHaveBeenCalledTimes(1)
    } finally {
      Reflect.deleteProperty(globalThis, "window")
    }
  })
})

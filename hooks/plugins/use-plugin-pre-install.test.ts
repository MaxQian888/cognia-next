import { act, renderHook } from "@testing-library/react"
import { usePluginPreInstall } from "./use-plugin-pre-install"
import type { RunMarketplaceInstallOpts } from "@/lib/plugin/marketplace/install-flow"
import type { PluginManifest } from "@/types/plugin"

const trackEvent = jest.fn(async () => true)
jest.mock("@/lib/telemetry/events/track-event", () => ({
  trackEvent: (...args: unknown[]) => trackEvent(...(args as [])),
}))

jest.mock("@/lib/db/plugins", () => ({
  listPlugins: jest.fn().mockResolvedValue([]),
  setPluginConfig: jest.fn().mockResolvedValue(undefined),
}))

type MarketplaceClient = RunMarketplaceInstallOpts["client"]

function makeManifest(over: Partial<PluginManifest> = {}): PluginManifest {
  return {
    id: "demo-plugin",
    name: "Demo",
    version: "1.0.0",
    type: "frontend",
    capabilities: [],
    ...over,
  } as PluginManifest
}

function makeClient(over: Partial<MarketplaceClient> = {}): MarketplaceClient {
  return {
    getPlugin: jest.fn().mockResolvedValue({ manifest: makeManifest(), name: "Demo" }),
    installPlugin: jest.fn().mockResolvedValue({ success: true }),
    ...over,
  }
}

describe("usePluginPreInstall", () => {
  it("returns failed/client_not_ready when client is null and never mounts dialog state", async () => {
    const { result } = renderHook(() => usePluginPreInstall(null))

    let resolved: Awaited<ReturnType<typeof result.current.install>> | undefined
    await act(async () => {
      resolved = await result.current.install("demo-plugin", "1.0.0", "Demo")
    })

    expect(resolved).toEqual({
      status: "failed",
      stage: "install",
      message: "client_not_ready",
    })
    expect(result.current.target).toBeNull()
    expect(result.current.busy).toBe(false)
  })

  it("delegates to runMarketplaceInstall when a client is provided and the manifest is bare", async () => {
    const client = makeClient()
    const { result } = renderHook(() => usePluginPreInstall(client))

    let resolved: Awaited<ReturnType<typeof result.current.install>> | undefined
    await act(async () => {
      resolved = await result.current.install("demo-plugin", "1.0.0", "Demo")
    })

    expect(resolved).toEqual({ status: "installed", pluginId: "demo-plugin" })
    // Adoption signal, outcome only — no plugin id leaves the process.
    expect(trackEvent).toHaveBeenCalledWith("app.plugin.installed", { outcome: "succeeded" })
    expect(client.installPlugin).toHaveBeenCalledWith("demo-plugin", "1.0.0")
    expect(result.current.target).toBeNull()
    expect(result.current.busy).toBe(false)
  })

  it("mounts permission target then resolves through resolveContinue when manifest declares permissions", async () => {
    const client = makeClient({
      getPlugin: jest.fn().mockResolvedValue({
        manifest: makeManifest({ permissions: ["filesystem:read" as never] }),
        name: "Demo",
      }),
    })

    const { result } = renderHook(() => usePluginPreInstall(client))

    let pending: Promise<unknown> | undefined
    await act(async () => {
      pending = result.current.install("demo-plugin", undefined, "Demo")
      // Yield a microtask so the orchestrator reaches the permission step.
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(result.current.target?.step).toBe("permission")

    await act(async () => {
      result.current.resolveContinue()
      await pending
    })

    expect(client.installPlugin).toHaveBeenCalledTimes(1)
    expect(result.current.target).toBeNull()
  })

  it("resolveCancel at the permission step cancels the chain without calling installPlugin", async () => {
    const client = makeClient({
      getPlugin: jest.fn().mockResolvedValue({
        manifest: makeManifest({ permissions: ["filesystem:read" as never] }),
        name: "Demo",
      }),
    })

    const { result } = renderHook(() => usePluginPreInstall(client))

    let pending: Promise<unknown> | undefined
    let resolved: Awaited<ReturnType<typeof result.current.install>> | undefined
    await act(async () => {
      pending = result.current.install("demo-plugin", undefined, "Demo").then((r) => {
        resolved = r
      })
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(result.current.target?.step).toBe("permission")

    await act(async () => {
      result.current.resolveCancel()
      await pending
    })

    expect(resolved).toEqual({ status: "cancelled", stage: "permission" })
    expect(trackEvent).toHaveBeenCalledWith("app.plugin.installed", {
      outcome: "cancelled",
      stage: "permission",
    })
    expect(client.installPlugin).not.toHaveBeenCalled()
  })

  it("resolveContinue at the config step forwards the user value into the orchestrator", async () => {
    const client = makeClient({
      getPlugin: jest.fn().mockResolvedValue({
        manifest: makeManifest({
          configSchema: { type: "object", properties: { token: { type: "string" } } },
        } as never),
        name: "Demo",
      }),
    })

    const { result } = renderHook(() => usePluginPreInstall(client))

    let pending: Promise<unknown> | undefined
    await act(async () => {
      pending = result.current.install("demo-plugin", undefined, "Demo")
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(result.current.target?.step).toBe("config")

    await act(async () => {
      result.current.resolveContinue({ token: "abc123" })
      await pending
    })

    expect(client.installPlugin).toHaveBeenCalledTimes(1)
    // setPluginConfig is mocked in lib/db/plugins; assert through that mock.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { setPluginConfig } = require("@/lib/db/plugins") as {
      setPluginConfig: jest.Mock
    }
    expect(setPluginConfig).toHaveBeenCalledWith("demo-plugin", { token: "abc123" })
  })
})

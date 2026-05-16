import {
  runMarketplaceInstall,
  type RunMarketplaceInstallOpts,
  type RunMarketplaceInstallResult,
} from "./install-flow"
import type { PluginManifest } from "@/types/plugin"

jest.mock("@/lib/db/plugins", () => ({
  listPlugins: jest.fn(),
  setPluginConfig: jest.fn(),
}))

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { listPlugins, setPluginConfig } = require("@/lib/db/plugins") as {
  listPlugins: jest.Mock
  setPluginConfig: jest.Mock
}

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

function makeOpts(over: Partial<RunMarketplaceInstallOpts> = {}): RunMarketplaceInstallOpts {
  const client = {
    getPlugin: jest.fn().mockResolvedValue({ manifest: makeManifest(), name: "Demo" }),
    installPlugin: jest.fn().mockResolvedValue({ success: true }),
  }
  return {
    pluginId: "demo-plugin",
    requestConflictReview: jest.fn().mockResolvedValue("continue"),
    requestPermissionReview: jest.fn().mockResolvedValue("approve"),
    requestConfig: jest.fn().mockResolvedValue({ result: "save", value: {} }),
    client,
    ...over,
  }
}

describe("runMarketplaceInstall", () => {
  beforeEach(() => {
    listPlugins.mockReset()
    listPlugins.mockResolvedValue([])
    setPluginConfig.mockReset()
    setPluginConfig.mockResolvedValue(undefined)
  })

  it("returns failed when the marketplace has no entry for the id", async () => {
    const client = {
      getPlugin: jest.fn().mockResolvedValue(null),
      installPlugin: jest.fn(),
    }
    const opts = makeOpts({ client })

    const result = await runMarketplaceInstall(opts)

    expect(result).toEqual<RunMarketplaceInstallResult>({
      status: "failed",
      stage: "install",
      message: "plugin_not_found",
    })
    expect(client.installPlugin).not.toHaveBeenCalled()
  })

  it("happy path: skips conflict + permission + config when manifest is bare", async () => {
    const opts = makeOpts()
    const result = await runMarketplaceInstall(opts)

    expect(result).toEqual({ status: "installed", pluginId: "demo-plugin" })
    expect(opts.requestConflictReview).not.toHaveBeenCalled()
    expect(opts.requestPermissionReview).not.toHaveBeenCalled()
    expect(opts.requestConfig).not.toHaveBeenCalled()
    expect(opts.client.installPlugin).toHaveBeenCalledWith("demo-plugin", undefined)
  })

  it("cancels at conflict step when an id is already installed and user backs out", async () => {
    listPlugins.mockResolvedValue([{ id: "demo-plugin", version: "0.9.0" }])
    const opts = makeOpts({
      requestConflictReview: jest.fn().mockResolvedValue("cancel"),
    })

    const result = await runMarketplaceInstall(opts)

    expect(result).toEqual({ status: "cancelled", stage: "conflict" })
    expect(opts.requestConflictReview).toHaveBeenCalledTimes(1)
    expect(opts.requestPermissionReview).not.toHaveBeenCalled()
    expect(opts.client.installPlugin).not.toHaveBeenCalled()
  })

  it("continues past conflict when the user confirms", async () => {
    listPlugins.mockResolvedValue([{ id: "demo-plugin", version: "0.9.0" }])
    const opts = makeOpts()

    const result = await runMarketplaceInstall(opts)

    expect(result).toEqual({ status: "installed", pluginId: "demo-plugin" })
    expect(opts.requestConflictReview).toHaveBeenCalledTimes(1)
  })

  it("requests permission review when manifest declares permissions and cancels there", async () => {
    const client = {
      getPlugin: jest.fn().mockResolvedValue({
        manifest: makeManifest({
          permissions: ["filesystem:read" as never],
        }),
        name: "Demo",
      }),
      installPlugin: jest.fn(),
    }
    const opts = makeOpts({
      client,
      requestPermissionReview: jest.fn().mockResolvedValue("cancel"),
    })

    const result = await runMarketplaceInstall(opts)

    expect(result).toEqual({ status: "cancelled", stage: "permission" })
    expect(opts.requestPermissionReview).toHaveBeenCalledTimes(1)
    expect(client.installPlugin).not.toHaveBeenCalled()
  })

  it("requests config when manifest has a non-empty configSchema and cancels there", async () => {
    const client = {
      getPlugin: jest.fn().mockResolvedValue({
        manifest: makeManifest({
          configSchema: {
            type: "object",
            properties: { token: { type: "string" } },
          },
        } as never),
        name: "Demo",
      }),
      installPlugin: jest.fn(),
    }
    const opts = makeOpts({
      client,
      requestConfig: jest.fn().mockResolvedValue({ result: "cancel" }),
    })

    const result = await runMarketplaceInstall(opts)

    expect(result).toEqual({ status: "cancelled", stage: "config" })
    expect(opts.requestConfig).toHaveBeenCalledTimes(1)
    expect(client.installPlugin).not.toHaveBeenCalled()
  })

  it("does NOT request permission review when there are no declared or optional permissions", async () => {
    const opts = makeOpts()
    await runMarketplaceInstall(opts)
    expect(opts.requestPermissionReview).not.toHaveBeenCalled()
  })

  it("does NOT request config when configSchema is empty / missing", async () => {
    const opts = makeOpts()
    await runMarketplaceInstall(opts)
    expect(opts.requestConfig).not.toHaveBeenCalled()
  })

  it("captures install errors and returns a failed result", async () => {
    const client = {
      getPlugin: jest.fn().mockResolvedValue({ manifest: makeManifest(), name: "Demo" }),
      installPlugin: jest.fn().mockRejectedValue(new Error("network down")),
    }
    const opts = makeOpts({ client })

    const result = await runMarketplaceInstall(opts)

    expect(result).toEqual({
      status: "failed",
      stage: "install",
      message: "network down",
    })
  })

  it("captures getPlugin throws and returns a failed result", async () => {
    const client = {
      getPlugin: jest.fn().mockRejectedValue(new Error("offline")),
      installPlugin: jest.fn(),
    }
    const opts = makeOpts({ client })

    const result = await runMarketplaceInstall(opts)

    expect(result).toEqual({
      status: "failed",
      stage: "install",
      message: "offline",
    })
    expect(client.installPlugin).not.toHaveBeenCalled()
  })

  it("persists user-supplied config to dexie after install success", async () => {
    const client = {
      getPlugin: jest.fn().mockResolvedValue({
        manifest: makeManifest({
          configSchema: {
            type: "object",
            properties: { token: { type: "string" } },
          },
        } as never),
        name: "Demo",
      }),
      installPlugin: jest.fn().mockResolvedValue({ success: true }),
    }
    const opts = makeOpts({
      client,
      requestConfig: jest.fn().mockResolvedValue({ result: "save", value: { token: "abc123" } }),
    })

    const result = await runMarketplaceInstall(opts)

    expect(result).toEqual({ status: "installed", pluginId: "demo-plugin" })
    expect(client.installPlugin).toHaveBeenCalledWith("demo-plugin", undefined)
    expect(setPluginConfig).toHaveBeenCalledWith("demo-plugin", { token: "abc123" })
    // setPluginConfig must be invoked after installPlugin — order matters
    // because the dexie row only exists once installPlugin returns.
    const installOrder = client.installPlugin.mock.invocationCallOrder[0]
    const configOrder = setPluginConfig.mock.invocationCallOrder[0]
    expect(configOrder).toBeGreaterThan(installOrder)
  })

  it("does NOT call setPluginConfig when the config step was skipped", async () => {
    const opts = makeOpts()
    const result = await runMarketplaceInstall(opts)
    expect(result).toEqual({ status: "installed", pluginId: "demo-plugin" })
    expect(setPluginConfig).not.toHaveBeenCalled()
  })

  it("does NOT call setPluginConfig when the user provided an empty {} payload", async () => {
    const client = {
      getPlugin: jest.fn().mockResolvedValue({
        manifest: makeManifest({
          configSchema: {
            type: "object",
            properties: { token: { type: "string" } },
          },
        } as never),
        name: "Demo",
      }),
      installPlugin: jest.fn().mockResolvedValue({ success: true }),
    }
    const opts = makeOpts({
      client,
      requestConfig: jest.fn().mockResolvedValue({ result: "save", value: {} }),
    })

    const result = await runMarketplaceInstall(opts)

    expect(result).toEqual({ status: "installed", pluginId: "demo-plugin" })
    expect(setPluginConfig).not.toHaveBeenCalled()
  })

  it("does NOT call setPluginConfig when the user cancels at the config step", async () => {
    const client = {
      getPlugin: jest.fn().mockResolvedValue({
        manifest: makeManifest({
          configSchema: {
            type: "object",
            properties: { token: { type: "string" } },
          },
        } as never),
        name: "Demo",
      }),
      installPlugin: jest.fn(),
    }
    const opts = makeOpts({
      client,
      requestConfig: jest.fn().mockResolvedValue({ result: "cancel" }),
    })

    const result = await runMarketplaceInstall(opts)

    expect(result).toEqual({ status: "cancelled", stage: "config" })
    expect(client.installPlugin).not.toHaveBeenCalled()
    expect(setPluginConfig).not.toHaveBeenCalled()
  })

  it("does NOT call setPluginConfig when installPlugin itself fails", async () => {
    const client = {
      getPlugin: jest.fn().mockResolvedValue({
        manifest: makeManifest({
          configSchema: {
            type: "object",
            properties: { token: { type: "string" } },
          },
        } as never),
        name: "Demo",
      }),
      installPlugin: jest.fn().mockRejectedValue(new Error("network down")),
    }
    const opts = makeOpts({
      client,
      requestConfig: jest.fn().mockResolvedValue({ result: "save", value: { token: "abc" } }),
    })

    const result = await runMarketplaceInstall(opts)

    expect(result).toEqual({
      status: "failed",
      stage: "install",
      message: "network down",
    })
    expect(setPluginConfig).not.toHaveBeenCalled()
  })

  it("surfaces a failed result when setPluginConfig throws after install success", async () => {
    setPluginConfig.mockRejectedValueOnce(new Error("indexeddb full"))
    const client = {
      getPlugin: jest.fn().mockResolvedValue({
        manifest: makeManifest({
          configSchema: {
            type: "object",
            properties: { token: { type: "string" } },
          },
        } as never),
        name: "Demo",
      }),
      installPlugin: jest.fn().mockResolvedValue({ success: true }),
    }
    const opts = makeOpts({
      client,
      requestConfig: jest.fn().mockResolvedValue({ result: "save", value: { token: "abc" } }),
    })

    const result = await runMarketplaceInstall(opts)

    expect(result).toEqual({
      status: "failed",
      stage: "install",
      message: "indexeddb full",
    })
    // installPlugin already ran — the dexie row exists, only the config
    // write failed. The orchestrator's contract is to surface this rather
    // than silently dropping the user's input.
    expect(client.installPlugin).toHaveBeenCalledTimes(1)
  })
})

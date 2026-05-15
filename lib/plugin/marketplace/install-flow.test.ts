import {
  runMarketplaceInstall,
  type RunMarketplaceInstallOpts,
  type RunMarketplaceInstallResult,
} from "./install-flow"
import type { PluginManifest } from "@/types/plugin"

jest.mock("@/lib/db/plugins", () => ({
  listPlugins: jest.fn(),
}))

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { listPlugins } = require("@/lib/db/plugins") as {
  listPlugins: jest.Mock
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
})

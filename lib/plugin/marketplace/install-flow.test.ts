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

  // -- ADR 0016 P1-6 — ConflictDetector wired into install pipeline ------------

  it("surfaces a command-conflict when an installed plugin owns the same command id", async () => {
    listPlugins.mockResolvedValue([
      {
        id: "other-plugin",
        manifest: makeManifest({
          id: "other-plugin",
          version: "1.0.0",
          commands: [{ id: "duplicate.command", title: "Dup" }],
        } as never),
      },
    ])
    const client = {
      getPlugin: jest.fn().mockResolvedValue({
        manifest: makeManifest({
          id: "demo-plugin",
          commands: [{ id: "duplicate.command", title: "Dup" }],
        } as never),
        name: "Demo",
      }),
      installPlugin: jest.fn(),
    }
    const requestConflictReview = jest.fn().mockResolvedValue("cancel")
    const opts = makeOpts({ client, requestConflictReview })

    const result = await runMarketplaceInstall(opts)

    expect(result).toEqual({ status: "cancelled", stage: "conflict" })
    expect(requestConflictReview).toHaveBeenCalledTimes(1)
    const conflictArg = requestConflictReview.mock.calls[0][0] as {
      reasons: Array<{ severity: string; message: string }>
    }
    expect(conflictArg.reasons.some((r) => r.message.startsWith("command:"))).toBe(true)
    expect(client.installPlugin).not.toHaveBeenCalled()
  })

  it("surfaces a shortcut-conflict alongside id-collision when both occur", async () => {
    listPlugins.mockResolvedValue([
      {
        id: "other-plugin",
        manifest: makeManifest({
          id: "other-plugin",
          version: "1.0.0",
          commands: [{ id: "other.cmd", title: "Other", shortcut: "ctrl+shift+x" }],
        } as never),
      },
      {
        id: "demo-plugin",
        version: "0.9.0",
        manifest: makeManifest({ id: "demo-plugin", version: "0.9.0" }),
      },
    ])
    const client = {
      getPlugin: jest.fn().mockResolvedValue({
        manifest: makeManifest({
          id: "demo-plugin",
          commands: [{ id: "demo.cmd", title: "Demo", shortcut: "ctrl+shift+x" }],
        } as never),
        name: "Demo",
      }),
      installPlugin: jest.fn().mockResolvedValue({ success: true }),
    }
    const requestConflictReview = jest.fn().mockResolvedValue("continue")
    const opts = makeOpts({ client, requestConflictReview })

    await runMarketplaceInstall(opts)

    const conflictArg = requestConflictReview.mock.calls[0][0] as {
      reasons: Array<{ severity: string; message: string }>
    }
    const messages = conflictArg.reasons.map((r) => r.message)
    expect(messages.some((m) => m.startsWith("alreadyInstalled:"))).toBe(true)
    expect(messages.some((m) => m.startsWith("shortcut:"))).toBe(true)
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

  it("invokes the rollback hook when setPluginConfig throws after install success", async () => {
    setPluginConfig.mockRejectedValueOnce(new Error("indexeddb full"))
    const rollback = jest.fn().mockResolvedValue(undefined)
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
      rollback,
    })

    const result = await runMarketplaceInstall(opts)

    expect(rollback).toHaveBeenCalledTimes(1)
    expect(rollback).toHaveBeenCalledWith("demo-plugin", expect.stringContaining("indexeddb full"))
    expect(result).toEqual({
      status: "failed",
      stage: "install",
      message: "indexeddb full",
    })
  })

  it("returns install-rollback failure when the rollback hook itself throws", async () => {
    setPluginConfig.mockRejectedValueOnce(new Error("indexeddb full"))
    const rollback = jest.fn().mockRejectedValue(new Error("uninstall locked"))
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
      rollback,
    })

    const result = await runMarketplaceInstall(opts)

    expect(result).toEqual({
      status: "failed",
      stage: "install-rollback",
      message: "uninstall locked",
    })
  })

  it("does not invoke the rollback hook when client.installPlugin itself failed", async () => {
    // installPlugin throw means the manager's own rollback already ran
    // (or never installed at all). The orchestrator must NOT double-roll-back.
    const rollback = jest.fn().mockResolvedValue(undefined)
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
      installPlugin: jest.fn().mockRejectedValue(new Error("net down")),
    }
    const opts = makeOpts({
      client,
      requestConfig: jest.fn().mockResolvedValue({ result: "save", value: { token: "abc" } }),
      rollback,
    })

    await runMarketplaceInstall(opts)
    expect(rollback).not.toHaveBeenCalled()
  })

  it("skips rollback entirely when opts.rollback is explicitly null", async () => {
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
      rollback: null,
    })

    const result = await runMarketplaceInstall(opts)
    expect(result).toEqual({
      status: "failed",
      stage: "install",
      message: "indexeddb full",
    })
  })

  describe("requires.binaries gate", () => {
    const manifestWithBinary = () =>
      makeManifest({
        requires: { binaries: [{ name: "git", minVersion: "2.0.0" }] },
      } as never)

    it("skips the gate when the manifest declares no binaries", async () => {
      const detectBinary = jest.fn()
      const opts = makeOpts({ detectBinary })
      const result = await runMarketplaceInstall(opts)
      expect(result).toEqual({ status: "installed", pluginId: "demo-plugin" })
      expect(detectBinary).not.toHaveBeenCalled()
    })

    it("proceeds when all required binaries are present and satisfy minVersion", async () => {
      const client = {
        getPlugin: jest.fn().mockResolvedValue({ manifest: manifestWithBinary(), name: "Demo" }),
        installPlugin: jest.fn().mockResolvedValue({ success: true }),
      }
      const detectBinary = jest
        .fn()
        .mockResolvedValue({ available: true, version: "git version 2.43.0" })
      const requestBinaryReview = jest.fn()
      const opts = makeOpts({ client, detectBinary, requestBinaryReview })

      const result = await runMarketplaceInstall(opts)
      expect(result).toEqual({ status: "installed", pluginId: "demo-plugin" })
      expect(detectBinary).toHaveBeenCalledWith("git")
      expect(requestBinaryReview).not.toHaveBeenCalled()
    })

    it("prompts the binary dialog when a required binary is missing", async () => {
      const client = {
        getPlugin: jest.fn().mockResolvedValue({ manifest: manifestWithBinary(), name: "Demo" }),
        installPlugin: jest.fn().mockResolvedValue({ success: true }),
      }
      const detectBinary = jest.fn().mockResolvedValue({ available: false, version: null })
      const requestBinaryReview = jest.fn().mockResolvedValue("proceed")
      const opts = makeOpts({ client, detectBinary, requestBinaryReview })

      const result = await runMarketplaceInstall(opts)
      expect(requestBinaryReview).toHaveBeenCalledTimes(1)
      expect(requestBinaryReview.mock.calls[0][0]).toMatchObject({
        pluginId: "demo-plugin",
        missing: [expect.objectContaining({ name: "git", minVersion: "2.0.0" })],
      })
      expect(result).toEqual({ status: "installed", pluginId: "demo-plugin" })
    })

    it("treats a below-minVersion binary as missing", async () => {
      const client = {
        getPlugin: jest.fn().mockResolvedValue({ manifest: manifestWithBinary(), name: "Demo" }),
        installPlugin: jest.fn().mockResolvedValue({ success: true }),
      }
      const detectBinary = jest
        .fn()
        .mockResolvedValue({ available: true, version: "git version 1.9.0" })
      const requestBinaryReview = jest.fn().mockResolvedValue("proceed")
      const opts = makeOpts({ client, detectBinary, requestBinaryReview })

      await runMarketplaceInstall(opts)
      expect(requestBinaryReview).toHaveBeenCalledTimes(1)
      expect(requestBinaryReview.mock.calls[0][0].missing[0]).toMatchObject({
        name: "git",
        detectedVersion: "git version 1.9.0",
      })
    })

    it("cancels at binary-requirements when the user backs out", async () => {
      const client = {
        getPlugin: jest.fn().mockResolvedValue({ manifest: manifestWithBinary(), name: "Demo" }),
        installPlugin: jest.fn().mockResolvedValue({ success: true }),
      }
      const detectBinary = jest.fn().mockResolvedValue({ available: false, version: null })
      const requestBinaryReview = jest.fn().mockResolvedValue("cancel")
      const opts = makeOpts({ client, detectBinary, requestBinaryReview })

      const result = await runMarketplaceInstall(opts)
      expect(result).toEqual({ status: "cancelled", stage: "binary-requirements" })
      expect(client.installPlugin).not.toHaveBeenCalled()
    })

    it("blocks the install when no binary-review UI is wired and a binary is missing", async () => {
      const client = {
        getPlugin: jest.fn().mockResolvedValue({ manifest: manifestWithBinary(), name: "Demo" }),
        installPlugin: jest.fn().mockResolvedValue({ success: true }),
      }
      const detectBinary = jest.fn().mockResolvedValue({ available: false, version: null })
      const opts = makeOpts({ client, detectBinary })
      // requestBinaryReview intentionally omitted.

      const result = await runMarketplaceInstall(opts)
      expect(result).toEqual({ status: "cancelled", stage: "binary-requirements" })
      expect(client.installPlugin).not.toHaveBeenCalled()
    })
  })

  describe("dependency requirements (Step 1.5)", () => {
    const clientWithDeps = (dependencies: Record<string, string>) => ({
      getPlugin: jest
        .fn()
        .mockResolvedValue({ manifest: makeManifest({ dependencies } as never), name: "Demo" }),
      installPlugin: jest.fn().mockResolvedValue({ success: true }),
    })

    it("blocks when a required dependency is missing and no review UI is wired", async () => {
      const client = clientWithDeps({ "dep-a": "^1.0.0" })
      const opts = makeOpts({
        client,
        checkInstalledPlugin: jest.fn().mockResolvedValue(null), // not installed
      })
      const result = await runMarketplaceInstall(opts)
      expect(result).toEqual({ status: "cancelled", stage: "dependencies" })
      expect(client.installPlugin).not.toHaveBeenCalled()
    })

    it("surfaces missing + conflicting deps to the review callback", async () => {
      const client = clientWithDeps({ "dep-a": "^1.0.0", "dep-b": "^2.0.0" })
      const requestDependencyReview = jest.fn().mockResolvedValue("cancel")
      const checkInstalledPlugin = jest.fn(async (id: string) =>
        id === "dep-b" ? { version: "1.5.0" } : null
      )
      const opts = makeOpts({ client, requestDependencyReview, checkInstalledPlugin })
      const result = await runMarketplaceInstall(opts)

      expect(result).toEqual({ status: "cancelled", stage: "dependencies" })
      const payload = requestDependencyReview.mock.calls[0][0] as {
        missing: string[]
        conflicts: Array<{ pluginId: string; required: string; available: string }>
      }
      expect(payload.missing).toEqual(["dep-a"])
      expect(payload.conflicts).toEqual([
        { pluginId: "dep-b", required: "^2.0.0", available: "1.5.0" },
      ])
    })

    it("proceeds when the user continues past unmet dependencies", async () => {
      const client = clientWithDeps({ "dep-a": "^1.0.0" })
      const opts = makeOpts({
        client,
        checkInstalledPlugin: jest.fn().mockResolvedValue(null),
        requestDependencyReview: jest.fn().mockResolvedValue("continue"),
      })
      const result = await runMarketplaceInstall(opts)
      expect(result).toEqual({ status: "installed", pluginId: "demo-plugin" })
      expect(client.installPlugin).toHaveBeenCalled()
    })

    it("does not gate when every required dependency is satisfied", async () => {
      const client = clientWithDeps({ "dep-a": "^1.0.0" })
      const requestDependencyReview = jest.fn()
      const opts = makeOpts({
        client,
        requestDependencyReview,
        checkInstalledPlugin: jest.fn().mockResolvedValue({ version: "1.4.0" }),
      })
      const result = await runMarketplaceInstall(opts)
      expect(result).toEqual({ status: "installed", pluginId: "demo-plugin" })
      expect(requestDependencyReview).not.toHaveBeenCalled()
    })

    it("ignores optionalDependencies (only required `dependencies` gate)", async () => {
      const client = {
        getPlugin: jest.fn().mockResolvedValue({
          manifest: makeManifest({ optionalDependencies: { "opt-a": "^1.0.0" } } as never),
          name: "Demo",
        }),
        installPlugin: jest.fn().mockResolvedValue({ success: true }),
      }
      const requestDependencyReview = jest.fn()
      const checkInstalledPlugin = jest.fn().mockResolvedValue(null)
      const opts = makeOpts({ client, requestDependencyReview, checkInstalledPlugin })
      const result = await runMarketplaceInstall(opts)
      expect(result).toEqual({ status: "installed", pluginId: "demo-plugin" })
      expect(requestDependencyReview).not.toHaveBeenCalled()
      expect(checkInstalledPlugin).not.toHaveBeenCalled()
    })
  })
})

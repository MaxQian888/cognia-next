/** @jest-environment node */

import type {
  ExternalAgentJsDistribution,
  ExternalAgentRuntimeCatalogEntry,
  ExternalAgentRuntimeReceipt,
} from "@/types/agent/external-agent-lifecycle"

const LOCK_SHA = "a".repeat(64)
const NOW = new Date("2026-08-22T12:00:00.000Z")

const distribution: ExternalAgentJsDistribution = {
  provider: "npm",
  packageName: "@example/agent",
  version: "1.0.0",
  entrypoint: "node_modules/.bin/example-agent",
  lockAsset: { path: "runtime/example/package-lock.json", sha256: LOCK_SHA },
}

const nextVersion: ExternalAgentJsDistribution = { ...distribution, version: "2.0.0" }

const managedEntry: ExternalAgentRuntimeCatalogEntry = {
  runtimeId: "example",
  presetIds: ["example"],
  displayName: "Example",
  ownership: "managed",
  protocol: "acp",
  transport: "stdio",
  platforms: ["darwin", "linux"],
  versionProbe: { args: ["--version"], parser: "semver-anywhere", timeoutMs: 5000 },
  supportedRange: ">=1.0.0",
  certifiedVersions: ["1.0.0"],
  distributions: [distribution, nextVersion],
  sandbox: { required: true, windowsExceptionEligible: false },
}

const systemEntry: ExternalAgentRuntimeCatalogEntry = {
  ...managedEntry,
  runtimeId: "system-thing",
  ownership: "system",
  systemCommand: "droid",
  distributions: [],
}

const catalogEntries = new Map<string, ExternalAgentRuntimeCatalogEntry>([
  [managedEntry.runtimeId, managedEntry],
  [systemEntry.runtimeId, systemEntry],
])

jest.mock("../runtime-catalog", () => {
  const actual = jest.requireActual("../runtime-catalog")
  return {
    ...actual,
    findRuntimeById: (id: string) => catalogEntries.get(id),
  }
})

import { createRuntimeHost, type RuntimeHostDependencies } from "./runtime-host"
import type { ExecResult, ProviderHost } from "./providers"
import type { ReceiptStore } from "./receipts"

// ---------------------------------------------------------------------------

interface FakeHost extends ProviderHost {
  files: Map<string, string>
  dirs: Set<string>
  execHandler: (command: string, args: string[]) => ExecResult
  treeDigest: string
}

function fakeHost(overrides: Partial<FakeHost> = {}): FakeHost {
  const files = new Map<string, string>()
  const dirs = new Set<string>()

  const host: FakeHost = {
    files,
    dirs,
    treeDigest: "t".repeat(64),
    execHandler: () => ({ code: 0, stdout: "1.0.0", stderr: "" }),

    join: (...parts) => parts.join("/"),
    exists: async (path) => files.has(path) || dirs.has(path),
    mkdirp: async (path) => {
      dirs.add(path)
    },
    removeDir: async (path) => {
      dirs.delete(path)
      for (const key of [...files.keys()]) if (key.startsWith(`${path}/`)) files.delete(key)
      for (const key of [...dirs]) if (key.startsWith(`${path}/`)) dirs.delete(key)
    },
    rename: async (from, to) => {
      if (dirs.has(to)) throw new Error(`rename target exists: ${to}`)
      if (dirs.delete(from)) dirs.add(to)
      for (const key of [...files.keys()]) {
        if (key === from || key.startsWith(`${from}/`)) {
          files.set(key.replace(from, to), files.get(key)!)
          files.delete(key)
        }
      }
      for (const key of [...dirs]) {
        if (key.startsWith(`${from}/`)) {
          dirs.add(key.replace(from, to))
          dirs.delete(key)
        }
      }
    },
    writeFile: async (path, contents) => {
      files.set(path, contents)
      // A real frozen install materializes the bin shim; the fake stands in for
      // it so `verify` has something to find.
      if (path.endsWith("package.json")) {
        files.set(path.replace("package.json", distribution.entrypoint), "#!/bin/sh")
      }
    },
    readFile: async (path) => {
      const value = files.get(path)
      if (value === undefined) throw new Error(`no such file: ${path}`)
      return value
    },
    hashFile: async () => LOCK_SHA,
    hashTree: async () => host.treeDigest,
    exec: async (command, args) => host.execHandler(command, args),
    download: async () => {},
    extract: async () => {},
    platformKey: () => "darwin-arm64",
    now: () => NOW,
    ...overrides,
  }
  return host
}

function fakeReceipts() {
  const store = new Map<string, ExternalAgentRuntimeReceipt>()
  const receipts: ReceiptStore & { store: Map<string, ExternalAgentRuntimeReceipt> } = {
    store,
    load: async (runtimeId) => store.get(runtimeId) ?? null,
    save: async (receipt) => {
      store.set(receipt.runtimeId, receipt)
    },
    delete: async (runtimeId) => {
      store.delete(runtimeId)
    },
  }
  return receipts
}

function build(overrides: Partial<RuntimeHostDependencies> = {}) {
  const host = (overrides.host as FakeHost) ?? fakeHost()
  const receipts = (overrides.receipts as ReturnType<typeof fakeReceipts>) ?? fakeReceipts()

  const deps: RuntimeHostDependencies = {
    rootDir: "/managed",
    resolveLockAsset: async () => "/repo/lock",
    probeVersion: async () => ({ output: "example 1.0.0" }),
    ...overrides,
    // The concrete fakes win, so a caller can override one without losing the
    // other's instrumentation.
    host,
    receipts,
  }

  host.files.set("/repo/lock", "lockfile-contents")
  return { runtimeHost: createRuntimeHost(deps), host, receipts, deps }
}

// ---------------------------------------------------------------------------

describe("install", () => {
  it("stages, verifies, health-checks and only then activates", async () => {
    const { runtimeHost, host, receipts } = build()

    const receipt = await runtimeHost.install("example")

    expect(receipt).toMatchObject({
      runtimeId: "example",
      version: "1.0.0",
      provider: "npm",
      source: "@example/agent@1.0.0",
      installRoot: "/managed/example/current",
      treeDigest: "t".repeat(64),
      lockDigest: LOCK_SHA,
    })
    expect(receipt.health.healthy).toBe(true)
    expect(receipt.entrypoint).toBe(`/managed/example/current/${distribution.entrypoint}`)
    expect(host.dirs.has("/managed/example/current")).toBe(true)
    expect(host.dirs.has("/managed/example/staging")).toBe(false)
    expect(await receipts.load("example")).toEqual(receipt)
  })

  it("installs an exact non-default version when asked", async () => {
    const { runtimeHost } = build()
    const receipt = await runtimeHost.install("example", "2.0.0")
    expect(receipt.version).toBe("2.0.0")
  })

  it("refuses a version the catalog has no approved distribution for", async () => {
    const { runtimeHost } = build()
    await expect(runtimeHost.install("example", "9.9.9")).rejects.toMatchObject({
      code: "integrity_failed",
    })
  })

  it("leaves the running version in place when the staged tree fails health", async () => {
    const { runtimeHost, host, receipts } = build()
    const first = await runtimeHost.install("example")

    host.execHandler = (command) =>
      command.includes("example-agent")
        ? { code: 1, stdout: "", stderr: "missing native module" }
        : { code: 0, stdout: "10.9.0", stderr: "" }

    await expect(runtimeHost.install("example", "2.0.0")).rejects.toMatchObject({
      code: "integrity_failed",
    })

    // The whole point of health-checking the STAGED tree.
    expect(await receipts.load("example")).toEqual(first)
    expect(host.dirs.has("/managed/example/staging")).toBe(false)
  })

  it("refuses to install a runtime the user's package manager owns", async () => {
    const { runtimeHost } = build()
    await expect(runtimeHost.install("system-thing")).rejects.toMatchObject({
      code: "runtime_referenced",
    })
  })

  it("refuses an unknown runtime", async () => {
    const { runtimeHost } = build()
    await expect(runtimeHost.install("ghost")).rejects.toMatchObject({ code: "runtime_missing" })
  })

  it("refuses a platform the runtime does not support", async () => {
    const { runtimeHost } = build({ host: fakeHost({ platformKey: () => "win32-x64" }) })
    await expect(runtimeHost.install("example")).rejects.toMatchObject({
      code: "platform_unsupported",
    })
  })

  it("refuses to switch providers silently", async () => {
    const { runtimeHost } = build({ preferredProvider: "bun" })
    // Only an npm distribution is catalogued, so honouring "bun" is impossible.
    await expect(runtimeHost.install("example")).rejects.toMatchObject({
      code: "consent_required",
    })
  })
})

describe("update and rollback", () => {
  it("keeps the replaced install as the single rollback slot", async () => {
    const { runtimeHost } = build()
    await runtimeHost.install("example")

    const updated = await runtimeHost.update("example", "2.0.0")

    expect(updated.version).toBe("2.0.0")
    expect(updated.previous?.version).toBe("1.0.0")
  })

  it("restores the predecessor and clears the slot", async () => {
    const { runtimeHost, host, receipts } = build()
    await runtimeHost.install("example")
    host.files.set("/managed/example/current/marker.txt", "v1")
    await runtimeHost.update("example", "2.0.0")

    const restored = await runtimeHost.rollback("example")

    expect(restored.version).toBe("1.0.0")
    expect(restored.previous).toBeUndefined()
    expect(host.files.get("/managed/example/current/marker.txt")).toBe("v1")
    expect((await receipts.load("example"))?.version).toBe("1.0.0")
  })

  it("refuses to roll back a fresh install with nothing behind it", async () => {
    const { runtimeHost } = build()
    await runtimeHost.install("example")
    await expect(runtimeHost.rollback("example")).rejects.toMatchObject({
      code: "runtime_missing",
    })
  })

  it("refuses to roll back a runtime Cognia does not manage", async () => {
    const { runtimeHost } = build()
    await expect(runtimeHost.rollback("system-thing")).rejects.toMatchObject({
      code: "runtime_referenced",
    })
  })
})

describe("uninstall", () => {
  it("removes the Cognia-owned root and the receipt", async () => {
    const { runtimeHost, host, receipts } = build()
    await runtimeHost.install("example")
    host.dirs.add("/managed/other")

    await runtimeHost.uninstall("example")

    expect(host.dirs.has("/managed/example")).toBe(false)
    expect(host.dirs.has("/managed/other")).toBe(true)
    expect(await receipts.load("example")).toBeNull()
  })

  it("never removes a system-owned runtime", async () => {
    const { runtimeHost } = build()
    await expect(runtimeHost.uninstall("system-thing")).rejects.toMatchObject({
      code: "runtime_referenced",
    })
  })
})

describe("inspect", () => {
  it("reports the certified verdict alongside the receipt", async () => {
    const { runtimeHost } = build()
    await runtimeHost.install("example")

    const result = await runtimeHost.inspect("example")

    expect(result.assessment.verdict).toBe("certified")
    expect(result.assessment.detectedVersion).toBe("1.0.0")
    expect(result.receipt?.version).toBe("1.0.0")
  })

  it("reports a missing runtime when the probe finds nothing", async () => {
    const { runtimeHost } = build({ probeVersion: async () => ({}) })
    const result = await runtimeHost.inspect("example")
    expect(result.assessment.verdict).toBe("missing")
  })

  it("refuses a managed tree that drifted from its receipt", async () => {
    const { runtimeHost, host } = build()
    await runtimeHost.install("example")

    // A root Cognia owns should never change underneath it.
    host.treeDigest = "z".repeat(64)
    const result = await runtimeHost.inspect("example")

    expect(result.assessment.verdict).toBe("unsupported")
    expect(result.assessment.blockingCode).toBe("integrity_failed")
  })

  it("does not claim a remote runtime is missing", async () => {
    catalogEntries.set("remote-thing", {
      ...managedEntry,
      runtimeId: "remote-thing",
      ownership: "remote",
      versionProbe: undefined,
      distributions: [],
    })
    const { runtimeHost } = build()

    const result = await runtimeHost.inspect("remote-thing")

    expect(result.assessment.verdict).toBe("certified")
    catalogEntries.delete("remote-thing")
  })
})

describe("checkForUpdate", () => {
  it("returns nothing when the runtime has no update channel", async () => {
    const { runtimeHost } = build({ fetchUpdateChannel: async () => ({ version: "3.0.0" }) })
    await expect(runtimeHost.checkForUpdate("example")).resolves.toBeNull()
  })

  it("returns nothing when the host cannot fetch channels at all", async () => {
    catalogEntries.set("example", {
      ...managedEntry,
      updateChannel: { url: "https://example.test/channel.json" },
    })
    const { runtimeHost } = build()
    await expect(runtimeHost.checkForUpdate("example")).resolves.toBeNull()
    catalogEntries.set("example", managedEntry)
  })

  it("offers a catalogued version as installable", async () => {
    catalogEntries.set("example", {
      ...managedEntry,
      updateChannel: { url: "https://example.test/channel.json" },
    })
    const { runtimeHost } = build({ fetchUpdateChannel: async () => ({ version: "2.0.0" }) })

    const candidate = await runtimeHost.checkForUpdate("example")

    expect(candidate).toMatchObject({
      toVersion: "2.0.0",
      installable: true,
      certified: false,
      provider: "npm",
    })
    catalogEntries.set("example", managedEntry)
  })

  it("marks a version the catalog does not carry as discoverable but not installable", async () => {
    catalogEntries.set("example", {
      ...managedEntry,
      updateChannel: { url: "https://example.test/channel.json" },
    })
    const { runtimeHost } = build({ fetchUpdateChannel: async () => ({ version: "5.0.0" }) })

    const candidate = await runtimeHost.checkForUpdate("example")

    // Surfacing it as installable would invite an install that must then
    // resolve at install time.
    expect(candidate).toMatchObject({ installable: false, blockingCode: "integrity_failed" })
    catalogEntries.set("example", managedEntry)
  })

  it("returns nothing when the channel offers what is already installed", async () => {
    catalogEntries.set("example", {
      ...managedEntry,
      updateChannel: { url: "https://example.test/channel.json" },
    })
    const { runtimeHost } = build({ fetchUpdateChannel: async () => ({ version: "1.0.0" }) })
    await runtimeHost.install("example")

    await expect(runtimeHost.checkForUpdate("example")).resolves.toBeNull()
    catalogEntries.set("example", managedEntry)
  })

  it("ignores a malformed channel document rather than trusting it", async () => {
    catalogEntries.set("example", {
      ...managedEntry,
      updateChannel: { url: "https://example.test/channel.json" },
    })
    for (const document of [null, "2.0.0", { version: 3 }, { version: "latest" }, {}]) {
      const { runtimeHost } = build({ fetchUpdateChannel: async () => document })
      await expect(runtimeHost.checkForUpdate("example")).resolves.toBeNull()
    }
    catalogEntries.set("example", managedEntry)
  })
})

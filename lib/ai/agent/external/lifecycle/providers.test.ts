/** @jest-environment node */

import {
  ExternalAgentLifecycleError,
  type ExternalAgentBinaryDistribution,
  type ExternalAgentDistribution,
  type ExternalAgentJsDistribution,
  type ExternalAgentUvxDistribution,
} from "@/types/agent/external-agent-lifecycle"

import {
  allProviderAdapters,
  availableProviders,
  binaryProviderAdapter,
  createJsProviderAdapter,
  getProviderAdapter,
  managedLayout,
  uvxProviderAdapter,
  type ExecResult,
  type ProviderContext,
  type ProviderHost,
} from "./providers"

const LOCK_SHA = "a".repeat(64)
const ARTIFACT_SHA = "b".repeat(64)
const NOW = new Date("2026-08-22T12:00:00.000Z")

// ---------------------------------------------------------------------------
// In-memory host
// ---------------------------------------------------------------------------

interface FakeHost extends ProviderHost {
  files: Map<string, string>
  dirs: Set<string>
  execLog: { command: string; args: string[]; cwd?: string }[]
  downloads: string[]
  extractions: { archivePath: string; destination: string }[]
  execHandler: (command: string, args: string[], cwd?: string) => ExecResult
  fileHashes: Map<string, string>
}

function fakeHost(overrides: Partial<FakeHost> = {}): FakeHost {
  const files = new Map<string, string>()
  const dirs = new Set<string>()
  const fileHashes = new Map<string, string>()

  const host: FakeHost = {
    files,
    dirs,
    fileHashes,
    execLog: [],
    downloads: [],
    extractions: [],
    execHandler: () => ({ code: 0, stdout: "1.2.3", stderr: "" }),

    join: (...parts) => parts.join("/"),
    exists: async (path) => files.has(path) || dirs.has(path),
    mkdirp: async (path) => {
      dirs.add(path)
    },
    removeDir: async (path) => {
      dirs.delete(path)
      for (const key of [...files.keys()]) {
        if (key.startsWith(`${path}/`)) files.delete(key)
      }
      for (const key of [...dirs]) {
        if (key.startsWith(`${path}/`)) dirs.delete(key)
      }
    },
    rename: async (from, to) => {
      if (dirs.has(to) || files.has(to)) {
        // POSIX will not rename a directory over an existing one; the fake must
        // not be more permissive than the real thing.
        throw new Error(`rename target exists: ${to}`)
      }
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
    },
    readFile: async (path) => {
      const value = files.get(path)
      if (value === undefined) throw new Error(`no such file: ${path}`)
      return value
    },
    hashFile: async (path) => fileHashes.get(path) ?? LOCK_SHA,
    hashTree: async () => "t".repeat(64),
    exec: async (command, args, options) => {
      host.execLog.push({ command, args, cwd: options?.cwd })
      return host.execHandler(command, args, options?.cwd)
    },
    download: async (url, destination) => {
      host.downloads.push(url)
      files.set(destination, `bytes-of:${url}`)
    },
    extract: async (archivePath, destination) => {
      host.extractions.push({ archivePath, destination })
    },
    platformKey: () => "darwin-arm64",
    now: () => NOW,
    ...overrides,
  }
  return host
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const jsDistribution: ExternalAgentJsDistribution = {
  provider: "npm",
  packageName: "@example/agent",
  version: "1.2.3",
  entrypoint: "node_modules/.bin/example-agent",
  lockAsset: { path: "runtime/example/package-lock.json", sha256: LOCK_SHA },
}

const uvxDistribution: ExternalAgentUvxDistribution = {
  provider: "uvx",
  packageName: "example-agent",
  version: "4.5.6",
  entrypoint: "bin/example-agent",
  lockAsset: { path: "runtime/example/uv.lock", sha256: LOCK_SHA },
}

const binaryDistribution: ExternalAgentBinaryDistribution = {
  provider: "binary",
  version: "7.8.9",
  artifacts: [
    {
      platformKey: "darwin-arm64",
      url: "https://example.test/agent.tar.gz",
      integrity: { sha256: ARTIFACT_SHA },
      archive: "tar.gz",
      entrypoint: "bin/agent",
    },
  ],
}

/**
 * `lockAssetPath: null` means "the host resolved no approved lock", which is a
 * distinct case from "the default fixture" — a defaulted `undefined` would
 * silently fall back to the fixture and make the refusal tests vacuous.
 */
function context(
  host: FakeHost,
  distribution: ExternalAgentDistribution,
  lockAssetPath: string | null = "/repo/lock"
): ProviderContext {
  return {
    host,
    layout: managedLayout(host, "/managed", "example"),
    runtimeId: "example",
    distribution,
    lockAssetPath: distribution.provider === "binary" ? undefined : (lockAssetPath ?? undefined),
  }
}

function seedLock(host: FakeHost) {
  host.files.set("/repo/lock", "lockfile-contents")
  host.fileHashes.set("/repo/lock", LOCK_SHA)
}

// ---------------------------------------------------------------------------

describe("registry", () => {
  it("exposes exactly the five catalogued providers", () => {
    expect(
      allProviderAdapters()
        .map((adapter) => adapter.provider)
        .sort()
    ).toEqual(["binary", "bun", "npm", "pnpm", "uvx"])
  })

  it("resolves each provider by name", () => {
    for (const provider of ["npm", "pnpm", "bun", "uvx", "binary"] as const) {
      expect(getProviderAdapter(provider).provider).toBe(provider)
    }
  })

  it("refuses an unknown provider with a stable code", () => {
    expect(() => getProviderAdapter("brew" as never)).toThrow(ExternalAgentLifecycleError)
  })

  it("reports which providers this host can actually run", async () => {
    const host = fakeHost({
      execHandler: (command) =>
        command === "npm"
          ? { code: 0, stdout: "10.9.0", stderr: "" }
          : { code: 127, stdout: "", stderr: "not found" },
    })
    const available = await availableProviders(host)
    expect(available).toContain("npm")
    expect(available).not.toContain("pnpm")
    // The binary provider needs no tool, so it is always available.
    expect(available).toContain("binary")
  })

  it("treats a throwing exec as unavailable rather than crashing discovery", async () => {
    const host = fakeHost({
      execHandler: () => {
        throw new Error("spawn ENOENT")
      },
    })
    await expect(availableProviders(host)).resolves.toEqual(["binary"])
  })
})

describe("managedLayout", () => {
  it("puts every directory under one removable root", () => {
    const layout = managedLayout(fakeHost(), "/managed", "example")
    expect(layout).toEqual({
      root: "/managed/example",
      current: "/managed/example/current",
      previous: "/managed/example/previous",
      staging: "/managed/example/staging",
    })
    for (const path of [layout.current, layout.previous, layout.staging]) {
      expect(path.startsWith(`${layout.root}/`)).toBe(true)
    }
  })
})

describe.each([
  ["npm", ["ci"], "package-lock.json"],
  ["pnpm", ["install", "--frozen-lockfile"], "pnpm-lock.yaml"],
  ["bun", ["install", "--frozen-lockfile"], "bun.lock"],
] as const)("%s provider", (provider, expectedArgs, lockfile) => {
  const adapter = createJsProviderAdapter(provider)
  const distribution = { ...jsDistribution, provider }

  it("installs in frozen mode against the approved lock", async () => {
    const host = fakeHost()
    seedLock(host)
    const ctx = context(host, distribution)

    const prepared = await adapter.prepare(ctx)

    const call = host.execLog.find((entry) => entry.command === provider)
    expect(call?.args).toEqual([...expectedArgs])
    expect(call?.cwd).toBe(ctx.layout.staging)
    expect(host.files.get(`${ctx.layout.staging}/${lockfile}`)).toBe("lockfile-contents")
    expect(prepared.stagedPath).toBe(ctx.layout.staging)
    expect(prepared.source).toBe("@example/agent@1.2.3")
  })

  it("writes a manifest pinned to the exact catalog version", async () => {
    const host = fakeHost()
    seedLock(host)
    const ctx = context(host, distribution)

    await adapter.prepare(ctx)

    const manifest = JSON.parse(host.files.get(`${ctx.layout.staging}/package.json`)!)
    expect(manifest.dependencies["@example/agent"]).toBe("1.2.3")
  })

  it("refuses to install with no approved lock rather than resolving a range", async () => {
    const host = fakeHost()
    await expect(adapter.prepare(context(host, distribution, null))).rejects.toMatchObject({
      code: "integrity_failed",
    })
    expect(host.execLog.some((entry) => entry.command === provider)).toBe(false)
  })

  it("surfaces a failed frozen install instead of continuing", async () => {
    const host = fakeHost({
      execHandler: (command) =>
        command === provider
          ? { code: 1, stdout: "", stderr: "lockfile out of date" }
          : { code: 0, stdout: "1.0.0", stderr: "" },
    })
    seedLock(host)
    await expect(adapter.prepare(context(host, distribution))).rejects.toMatchObject({
      code: "integrity_failed",
    })
  })

  it("clears a half-finished staging tree before retrying", async () => {
    const host = fakeHost()
    seedLock(host)
    const ctx = context(host, distribution)
    host.dirs.add(ctx.layout.staging)
    host.files.set(`${ctx.layout.staging}/leftover.txt`, "junk")

    await adapter.prepare(ctx)

    expect(host.files.has(`${ctx.layout.staging}/leftover.txt`)).toBe(false)
  })

  it("verifies the entrypoint exists and the lock matches the catalog", async () => {
    const host = fakeHost()
    seedLock(host)
    const ctx = context(host, distribution)
    const prepared = await adapter.prepare(ctx)

    // Nothing created the bin shim yet.
    expect(await adapter.verify(ctx, prepared)).toMatchObject({ ok: false })

    host.files.set(prepared.entrypoint, "#!/bin/sh")
    expect(await adapter.verify(ctx, prepared)).toMatchObject({ ok: true })
  })

  it("fails verification when the lock bytes are not the approved ones", async () => {
    const host = fakeHost()
    host.files.set("/repo/lock", "tampered")
    host.fileHashes.set("/repo/lock", "f".repeat(64))
    const ctx = context(host, distribution)
    const prepared = await adapter.prepare(ctx)
    host.files.set(prepared.entrypoint, "#!/bin/sh")

    const result = await adapter.verify(ctx, prepared)
    expect(result.ok).toBe(false)
    expect(result.detail).toContain("approved")
  })
})

describe("uvx provider", () => {
  it("installs frozen and pins the exact version", async () => {
    const host = fakeHost()
    seedLock(host)
    const ctx = context(host, uvxDistribution)

    const prepared = await uvxProviderAdapter.prepare(ctx)

    const call = host.execLog.find((entry) => entry.command === "uv")
    expect(call?.args).toContain("--frozen")
    expect(call?.args).toContain("example-agent==4.5.6")
    expect(host.files.get(`${ctx.layout.staging}/uv.lock`)).toBe("lockfile-contents")
    expect(prepared.source).toBe("example-agent==4.5.6")
  })

  it("refuses with no approved uv.lock", async () => {
    await expect(
      uvxProviderAdapter.prepare(context(fakeHost(), uvxDistribution, null))
    ).rejects.toMatchObject({ code: "integrity_failed" })
  })
})

describe("binary provider", () => {
  it("verifies the checksum BEFORE unpacking anything", async () => {
    const host = fakeHost()
    const ctx = context(host, binaryDistribution)
    host.fileHashes.set(`${ctx.layout.staging}/artifact.download`, "wrong".padEnd(64, "0"))

    await expect(binaryProviderAdapter.prepare(ctx)).rejects.toMatchObject({
      code: "integrity_failed",
    })
    // Extracting an unverified archive is already executing attacker-chosen
    // paths on disk.
    expect(host.extractions).toEqual([])
  })

  it("downloads, verifies and unpacks a matching artifact", async () => {
    const host = fakeHost()
    const ctx = context(host, binaryDistribution)
    host.fileHashes.set(`${ctx.layout.staging}/artifact.download`, ARTIFACT_SHA)

    const prepared = await binaryProviderAdapter.prepare(ctx)

    expect(host.downloads).toEqual(["https://example.test/agent.tar.gz"])
    expect(host.extractions).toHaveLength(1)
    expect(prepared.entrypoint).toBe(`${ctx.layout.staging}/bin/agent`)
    expect(prepared.source).toBe("https://example.test/agent.tar.gz")
  })

  it("skips extraction for a bare executable", async () => {
    const host = fakeHost()
    const bare: ExternalAgentBinaryDistribution = {
      ...binaryDistribution,
      artifacts: [{ ...binaryDistribution.artifacts[0], archive: "none" }],
    }
    const ctx = context(host, bare)
    host.fileHashes.set(`${ctx.layout.staging}/artifact.download`, ARTIFACT_SHA)

    await binaryProviderAdapter.prepare(ctx)

    expect(host.extractions).toEqual([])
  })

  it("refuses a platform the release does not publish", async () => {
    const host = fakeHost({ platformKey: () => "linux-riscv64" })
    await expect(
      binaryProviderAdapter.prepare(context(host, binaryDistribution))
    ).rejects.toMatchObject({ code: "platform_unsupported" })
  })

  it("refuses a non-https artifact", async () => {
    const host = fakeHost()
    const insecure: ExternalAgentBinaryDistribution = {
      ...binaryDistribution,
      artifacts: [{ ...binaryDistribution.artifacts[0], url: "http://example.test/a.tar.gz" }],
    }
    await expect(binaryProviderAdapter.prepare(context(host, insecure))).rejects.toMatchObject({
      code: "integrity_failed",
    })
    expect(host.downloads).toEqual([])
  })
})

describe("activation, health and removal (shared by every provider)", () => {
  async function stage(host: FakeHost, distribution: ExternalAgentDistribution) {
    const adapter = getProviderAdapter(distribution.provider)
    const ctx = context(host, distribution)
    if (distribution.provider === "binary") {
      host.fileHashes.set(`${ctx.layout.staging}/artifact.download`, ARTIFACT_SHA)
    } else {
      seedLock(host)
    }
    const prepared = await adapter.prepare(ctx)
    host.files.set(prepared.entrypoint, "#!/bin/sh")
    return { adapter, ctx, prepared }
  }

  it("swaps staging into place and keeps the outgoing tree as the slot", async () => {
    const host = fakeHost()
    const { adapter, ctx } = await stage(host, jsDistribution)
    host.dirs.add(ctx.layout.current)
    host.files.set(`${ctx.layout.current}/marker.txt`, "old")

    await adapter.activate(ctx, await adapter.prepare(ctx))

    expect(host.files.get(`${ctx.layout.previous}/marker.txt`)).toBe("old")
    expect(host.dirs.has(ctx.layout.current)).toBe(true)
    expect(host.dirs.has(ctx.layout.staging)).toBe(false)
  })

  it("discards an older predecessor rather than accumulating trees", async () => {
    const host = fakeHost()
    const { adapter, ctx } = await stage(host, jsDistribution)
    host.dirs.add(ctx.layout.previous)
    host.files.set(`${ctx.layout.previous}/ancient.txt`, "two versions ago")
    host.dirs.add(ctx.layout.current)

    await adapter.activate(ctx, await adapter.prepare(ctx))

    expect(host.files.has(`${ctx.layout.previous}/ancient.txt`)).toBe(false)
  })

  it("activates cleanly when there is no existing installation", async () => {
    const host = fakeHost()
    const { adapter, ctx, prepared } = await stage(host, jsDistribution)
    await expect(adapter.activate(ctx, prepared)).resolves.toMatchObject({
      entrypoint: `${ctx.layout.current}/node_modules/.bin/example-agent`,
    })
  })

  it("passes health when the entrypoint reports a version", async () => {
    const host = fakeHost()
    const { adapter, ctx, prepared } = await stage(host, jsDistribution)
    const health = await adapter.healthCheck(ctx, prepared.entrypoint)
    expect(health.healthy).toBe(true)
    expect(health.checkedAt).toBe(NOW.toISOString())
  })

  it("fails health when the entrypoint exits non-zero", async () => {
    const host = fakeHost({
      execHandler: (command) =>
        command.includes("example-agent")
          ? { code: 1, stdout: "", stderr: "dyld: missing native module" }
          : { code: 0, stdout: "1.0.0", stderr: "" },
    })
    const { adapter, ctx, prepared } = await stage(host, jsDistribution)

    const health = await adapter.healthCheck(ctx, prepared.entrypoint)
    expect(health.healthy).toBe(false)
    expect(health.findings[0].code).toBe("entrypoint-failed")
    expect(health.findings[0].detail).toContain("missing native module")
  })

  it("fails health when the entrypoint says nothing at all", async () => {
    const host = fakeHost({
      execHandler: (command) =>
        command.includes("example-agent")
          ? { code: 0, stdout: "   ", stderr: "" }
          : { code: 0, stdout: "1.0.0", stderr: "" },
    })
    const { adapter, ctx, prepared } = await stage(host, jsDistribution)
    const health = await adapter.healthCheck(ctx, prepared.entrypoint)
    expect(health.healthy).toBe(false)
    expect(health.findings[0].code).toBe("entrypoint-silent")
  })

  it("fails health when the entrypoint cannot be launched at all", async () => {
    const host = fakeHost({
      execHandler: () => {
        throw new Error("spawn EACCES")
      },
    })
    seedLock(host)
    const adapter = getProviderAdapter("npm")
    const ctx = context(host, jsDistribution)
    const health = await adapter.healthCheck(ctx, "/managed/example/staging/bin/agent")
    expect(health.healthy).toBe(false)
    expect(health.findings[0].code).toBe("entrypoint-unlaunchable")
  })

  it("removes only the Cognia-owned root", async () => {
    const host = fakeHost()
    const { adapter, ctx } = await stage(host, jsDistribution)
    host.dirs.add("/managed/other-runtime")
    host.files.set("/usr/local/bin/agent", "system install")

    await adapter.remove(ctx)

    expect(host.dirs.has(ctx.layout.root)).toBe(false)
    expect(host.dirs.has("/managed/other-runtime")).toBe(true)
    // A runtime the user's own package manager owns is never touched.
    expect(host.files.get("/usr/local/bin/agent")).toBe("system install")
  })

  it("restores the retained predecessor on rollback", async () => {
    const host = fakeHost()
    const { adapter, ctx, prepared } = await stage(host, jsDistribution)
    await adapter.activate(ctx, prepared)
    host.dirs.add(ctx.layout.previous)
    host.files.set(`${ctx.layout.previous}/marker.txt`, "old")

    await adapter.rollback(ctx, {
      receiptId: "r",
      version: "1.0.0",
      installRoot: ctx.layout.current,
      entrypoint: `${ctx.layout.current}/node_modules/.bin/example-agent`,
      treeDigest: "t".repeat(64),
    })

    expect(host.files.get(`${ctx.layout.current}/marker.txt`)).toBe("old")
    expect(host.dirs.has(ctx.layout.previous)).toBe(false)
  })

  it("refuses to roll back with nothing retained", async () => {
    const host = fakeHost()
    const { adapter, ctx } = await stage(host, jsDistribution)
    await expect(
      adapter.rollback(ctx, {
        receiptId: "r",
        version: "1.0.0",
        installRoot: ctx.layout.current,
        entrypoint: "/e",
        treeDigest: "t".repeat(64),
      })
    ).rejects.toMatchObject({ code: "runtime_missing" })
  })
})

describe("provider version reporting", () => {
  it("records the provider tool's own version", async () => {
    const host = fakeHost({ execHandler: () => ({ code: 0, stdout: "10.9.0\n", stderr: "" }) })
    await expect(getProviderAdapter("npm").providerVersion(host)).resolves.toBe("10.9.0")
  })

  it("refuses when the provider tool is not usable", async () => {
    const host = fakeHost({ execHandler: () => ({ code: 127, stdout: "", stderr: "" }) })
    await expect(getProviderAdapter("pnpm").providerVersion(host)).rejects.toMatchObject({
      code: "runtime_missing",
    })
  })

  it("reports the host itself for the binary provider", async () => {
    await expect(binaryProviderAdapter.providerVersion(fakeHost())).resolves.toBe(
      "host:darwin-arm64"
    )
  })
})

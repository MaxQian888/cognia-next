jest.mock("@/lib/db/plugin-install-origins", () => ({ putInstallOrigin: jest.fn() }))
jest.mock("@cognia/logging", () => ({ loggers: { plugin: { warn: jest.fn() } } }))
jest.mock("@/lib/plugin/core/mirrored-client", () => ({ isMirroredPluginClient: () => false }))

import { loggers } from "@cognia/logging"

import { putInstallOrigin } from "@/lib/db/plugin-install-origins"

import {
  githubInstallOrigin,
  isFullCommitSha,
  isReproducibleOrigin,
  parseInstallOriginRecord,
  recordInstallOrigin,
  resolvePluginOrigin,
} from "./install-origin"

const SHA = "0123456789abcdef0123456789abcdef01234567"

describe("install origins", () => {
  beforeEach(() => jest.clearAllMocks())

  it("recognizes a full commit id only", () => {
    expect(isFullCommitSha(SHA)).toBe(true)
    expect(isFullCommitSha(SHA.toUpperCase())).toBe(true)
    expect(isFullCommitSha(SHA.slice(0, 12))).toBe(false)
    expect(isFullCommitSha("main")).toBe(false)
    expect(isFullCommitSha(undefined)).toBe(false)
  })

  it("treats every non-local origin as reproducible", () => {
    expect(isReproducibleOrigin({ kind: "builtin" })).toBe(true)
    expect(isReproducibleOrigin({ kind: "local", via: "directory" })).toBe(false)
    expect(isReproducibleOrigin(undefined)).toBe(false)
  })

  it("derives a built-in from its path and otherwise reads the record", () => {
    expect(resolvePluginOrigin({ path: "builtin://cognia-pdf" }, undefined)).toEqual({
      kind: "builtin",
    })
    const record = {
      pluginId: "x",
      version: "1.0.0",
      origin: { kind: "local" as const, via: "directory" as const },
      recordedAt: 1,
    }
    expect(resolvePluginOrigin({ path: "/plugins/x" }, record)).toEqual(record.origin)
    expect(resolvePluginOrigin({ path: "/plugins/x" }, undefined)).toBeUndefined()
  })

  it("records with a timestamp and the cogpack provenance", async () => {
    await recordInstallOrigin(
      {
        pluginId: "x",
        version: "1.0.0",
        origin: { kind: "local", via: "cogpack-embedded" },
        viaCogpack: { cogpackId: "writer", version: "1.0.0", fingerprint: "f" },
      },
      { now: () => 42 }
    )
    expect(putInstallOrigin).toHaveBeenCalledWith({
      pluginId: "x",
      version: "1.0.0",
      origin: { kind: "local", via: "cogpack-embedded" },
      viaCogpack: { cogpackId: "writer", version: "1.0.0", fingerprint: "f" },
      recordedAt: 42,
    })
  })

  it("forwards the record to the host on a mirrored client", async () => {
    const forward = jest.fn(async () => undefined)
    await recordInstallOrigin(
      { pluginId: "x", version: "1.0.0", origin: { kind: "builtin" } },
      { isMirror: () => true, forward, now: () => 5 }
    )
    expect(forward).toHaveBeenCalledWith({
      pluginId: "x",
      version: "1.0.0",
      origin: { kind: "builtin" },
      recordedAt: 5,
    })
    expect(putInstallOrigin).not.toHaveBeenCalled()
  })

  it("never fails the install when the write fails", async () => {
    ;(putInstallOrigin as jest.Mock).mockRejectedValueOnce(new Error("disk full"))
    await expect(
      recordInstallOrigin({ pluginId: "x", version: "1", origin: { kind: "builtin" } })
    ).resolves.toBeUndefined()
    expect(loggers.plugin.warn).toHaveBeenCalledWith("[plugin:x] failed to record install origin", {
      kind: "builtin",
      error: "disk full",
    })
  })

  it("pins a GitHub install only to a full commit", () => {
    expect(
      githubInstallOrigin({ repo: "acme/tools", gitRef: SHA.toUpperCase(), subdir: "pkg" })
    ).toEqual({ kind: "github", owner: "acme", repo: "tools", subdir: "pkg", commit: SHA })
    expect(githubInstallOrigin({ repo: "acme/tools", gitRef: "main" })).toBeNull()
    expect(githubInstallOrigin({ repo: "acme", gitRef: SHA })).toBeNull()
    expect(githubInstallOrigin({ repo: "acme/tools/x", gitRef: SHA })).toBeNull()
  })

  describe("parseInstallOriginRecord", () => {
    const base = { pluginId: "tools", version: "1.0.0", recordedAt: 5 }
    const FP = "a".repeat(64)

    it("accepts every origin kind a cogpack can pin, and local installs", () => {
      const origins = [
        { kind: "builtin" },
        { kind: "github", owner: "acme", repo: "tools", subdir: "pkg", commit: SHA },
        { kind: "git", url: "https://example.com/x.git", commit: SHA },
        { kind: "registry", registryUrl: "https://r.example.com", version: "1.0.0" },
        { kind: "url", bundleUrl: "https://example.com/b.zip", sha256: FP },
        { kind: "openvsx", namespace: "ms", name: "py", version: "1.0.0", sha256: FP },
        { kind: "local", via: "directory" },
      ]
      for (const origin of origins) {
        expect(parseInstallOriginRecord({ ...base, origin })).toEqual({ ...base, origin })
      }
      const viaCogpack = { cogpackId: "pack", version: "1.0.0", fingerprint: FP }
      expect(
        parseInstallOriginRecord({ ...base, origin: { kind: "builtin" }, viaCogpack, extra: 1 })
      ).toEqual({ ...base, origin: { kind: "builtin" }, viaCogpack })
    })

    it("refuses what a later export must not pin", () => {
      const bad = [
        { ...base, origin: { kind: "git", url: "http://example.com/x.git", commit: SHA } },
        { ...base, origin: { kind: "github", owner: "a", repo: "b", commit: "main" } },
        { ...base, origin: { kind: "url", bundleUrl: "https://e.com/b", sha256: "x" } },
        { ...base, origin: { kind: "local", via: "made-up" } },
        { ...base, origin: { kind: "made-up" } },
        { ...base, pluginId: "" },
        { ...base, recordedAt: Number.NaN, origin: { kind: "builtin" } },
        { ...base, origin: { kind: "builtin" }, viaCogpack: { cogpackId: "p", version: "1" } },
        null,
      ]
      for (const record of bad) expect(() => parseInstallOriginRecord(record)).toThrow()
    })
  })
})

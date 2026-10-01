/**
 * @jest-environment jsdom
 */

let tauri = true
jest.mock("@/lib/tauri", () => ({ isTauri: () => tauri }))
const getPlugin = jest.fn()
jest.mock("@/lib/db/plugins", () => ({ getPlugin: (id: string) => getPlugin(id) }))
const fetchGithubPluginPreview = jest.fn()
jest.mock("@/lib/plugin/package/github-source", () => ({
  fetchGithubPluginPreview: (ref: unknown) => fetchGithubPluginPreview(ref),
}))
const manager = { installPluginFromGithub: jest.fn(), installWasmPluginFromUrl: jest.fn() }
jest.mock("@/lib/plugin/core/manager", () => ({ getPluginManager: () => manager }))
const marketplace = { getRegistryUrl: jest.fn(), getPlugin: jest.fn(), installPlugin: jest.fn() }
jest.mock("@/lib/plugin/package/marketplace", () => ({ getPluginMarketplace: () => marketplace }))
const previewBundleManifest = jest.fn()
jest.mock("@/lib/plugin/package/http-installer", () => ({
  previewBundleManifest: (args: unknown) => previewBundleManifest(args),
}))
const openVsx = { getPlugin: jest.fn(), installPlugin: jest.fn() }
const createOpenVsxInstallClient = jest.fn((_deps: { viaCogpack?: unknown }) => openVsx)
jest.mock("@/lib/plugin/vscode-shim/openvsx-install-flow", () => ({
  createOpenVsxInstallClient: (deps: { viaCogpack?: unknown }) => createOpenVsxInstallClient(deps),
}))
const installFromGit = jest.fn()
jest.mock("@/lib/plugin/package/git-installer", () => ({
  installFromGit: (args: unknown) => installFromGit(args),
}))
const installEmbeddedPlugin = jest.fn()
jest.mock("./plugin-tree", () => ({
  installEmbeddedPlugin: (...args: unknown[]) => installEmbeddedPlugin(...args),
}))

import type { CogpackMember } from "@/types/plugin/plugin-cogset"

import { resolveCogpackMember } from "./resolvers"

const SHA = "0123456789abcdef0123456789abcdef01234567"
const viaCogpack = { cogpackId: "p", version: "1.0.0", fingerprint: "f" }
const member = (source: CogpackMember["source"], id = "x"): CogpackMember => ({
  id,
  name: id,
  version: "1.2.0",
  optional: false,
  source,
})

beforeEach(() => {
  jest.clearAllMocks()
  tauri = true
})

describe("resolveCogpackMember", () => {
  it("uses the installed built-in, or reports it missing", async () => {
    getPlugin.mockResolvedValueOnce({ manifest: { id: "x" } })
    await expect(resolveCogpackMember(member({ kind: "builtin" }), undefined)).resolves.toEqual({
      manifest: { id: "x" },
    })
    getPlugin.mockResolvedValueOnce(undefined)
    await expect(resolveCogpackMember(member({ kind: "builtin" }), undefined)).resolves.toEqual({
      unavailable: { reason: "builtin-missing" },
    })
  })

  it("needs the desktop app for anything that installs", async () => {
    tauri = false
    await expect(
      resolveCogpackMember(
        member({ kind: "github", owner: "a", repo: "b", commit: SHA }),
        undefined
      )
    ).resolves.toEqual({ unavailable: { reason: "desktop-only" } })
  })

  it("installs embedded files through the directory installer", async () => {
    const files = new Map([
      ["plugin.json", new TextEncoder().encode('{"id":"x","version":"1.2.0"}')],
    ])
    const resolution = await resolveCogpackMember(
      member({ kind: "embedded", root: "plugins/x", files: [] }),
      files
    )
    expect(resolution.manifest).toEqual({ id: "x", version: "1.2.0" })
    await resolution.install!({ viaCogpack })
    expect(installEmbeddedPlugin).toHaveBeenCalledWith(files, {
      pluginId: "x",
      pluginName: "x",
      version: "1.2.0",
      viaCogpack,
    })
    await expect(
      resolveCogpackMember(member({ kind: "embedded", root: "plugins/x", files: [] }), new Map())
    ).resolves.toEqual({ unavailable: { reason: "invalid-embedded" } })
    const impostor = new Map([
      ["plugin.json", new TextEncoder().encode('{"id":"other","version":"1.2.0"}')],
    ])
    await expect(
      resolveCogpackMember(member({ kind: "embedded", root: "plugins/x", files: [] }), impostor)
    ).resolves.toEqual({ unavailable: { reason: "invalid-embedded" } })
    // Files at another version than the signed pin would install code the
    // review and the cogset's expectedVersion do not describe.
    const otherVersion = new Map([
      ["plugin.json", new TextEncoder().encode('{"id":"x","version":"1.3.0"}')],
    ])
    await expect(
      resolveCogpackMember(member({ kind: "embedded", root: "plugins/x", files: [] }), otherVersion)
    ).resolves.toEqual({ unavailable: { reason: "invalid-embedded" } })
    // A case-only twin would overwrite the reviewed manifest on APFS / NTFS.
    const twin = new Map([
      ["plugin.json", new TextEncoder().encode('{"id":"x","version":"1.2.0"}')],
      [
        "PLUGIN.JSON",
        new TextEncoder().encode('{"id":"x","version":"1.2.0","permissions":["shell:execute"]}'),
      ],
    ])
    await expect(
      resolveCogpackMember(member({ kind: "embedded", root: "plugins/x", files: [] }), twin)
    ).resolves.toEqual({ unavailable: { reason: "invalid-embedded" } })
  })

  it("previews GitHub at the pinned commit and installs that commit", async () => {
    fetchGithubPluginPreview.mockResolvedValueOnce({
      manifest: { id: "x" },
      generatedFiles: { "plugin.json": "{}" },
      ref: { owner: "a", repo: "b", ref: SHA, subdir: "pkg" },
    })
    const resolution = await resolveCogpackMember(
      member({ kind: "github", owner: "a", repo: "b", subdir: "pkg", commit: SHA }),
      undefined
    )
    expect(fetchGithubPluginPreview).toHaveBeenCalledWith({
      owner: "a",
      repo: "b",
      ref: SHA,
      subdir: "pkg",
    })
    await resolution.install!({ viaCogpack })
    expect(manager.installPluginFromGithub).toHaveBeenCalledWith(
      "a/b",
      SHA,
      "pkg",
      { "plugin.json": "{}" },
      { viaCogpack }
    )
    fetchGithubPluginPreview.mockRejectedValueOnce(new Error("404"))
    await expect(
      resolveCogpackMember(
        member({ kind: "github", owner: "a", repo: "b", commit: SHA }),
        undefined
      )
    ).resolves.toEqual({ unavailable: { reason: "preview-failed", detail: "404" } })
  })

  it("installs the registry version without pulling dependencies, and refuses another registry", async () => {
    marketplace.getRegistryUrl.mockReturnValue("https://r.example")
    marketplace.getPlugin.mockResolvedValueOnce({ manifest: { id: "x" } })
    marketplace.installPlugin.mockResolvedValueOnce({ success: true })
    const resolution = await resolveCogpackMember(
      member({ kind: "registry", registryUrl: "https://r.example", version: "1.2.0" }),
      undefined
    )
    await resolution.install!({ viaCogpack })
    expect(marketplace.installPlugin).toHaveBeenCalledWith("x", "1.2.0", {
      installDependencies: false,
      viaCogpack,
    })
    marketplace.getPlugin.mockResolvedValueOnce({ manifest: { id: "x" } })
    marketplace.installPlugin.mockResolvedValueOnce({ success: false, error: "gone" })
    const failing = await resolveCogpackMember(
      member({ kind: "registry", registryUrl: "https://r.example", version: "1.2.0" }),
      undefined
    )
    await expect(failing.install!({ viaCogpack })).rejects.toThrow("gone")
    await expect(
      resolveCogpackMember(
        member({ kind: "registry", registryUrl: "https://other", version: "1.2.0" }),
        undefined
      )
    ).resolves.toEqual({ unavailable: { reason: "registry-mismatch" } })
  })

  it("previews and installs a signed bundle pinned by its hash, with the approved grant", async () => {
    previewBundleManifest.mockResolvedValueOnce({ manifest: { id: "x", type: "wasm" } })
    const source = {
      kind: "url" as const,
      bundleUrl: "https://b/x.zip",
      sha256: "a".repeat(64),
      publicKey: "K",
    }
    const resolution = await resolveCogpackMember(member(source), undefined)
    const args = {
      bundleUrl: "https://b/x.zip",
      signatureUrl: undefined,
      expectedPublicKeyBase64: "K",
      expectedBundleSha256: "a".repeat(64),
    }
    expect(previewBundleManifest).toHaveBeenCalledWith(args)
    const grantDecision = { pluginId: "x", grantedPermissions: [], grantedPreopens: [] }
    await resolution.install!({ viaCogpack, grantDecision })
    expect(manager.installWasmPluginFromUrl).toHaveBeenCalledWith(args, grantDecision, {
      viaCogpack,
    })
  })

  it("stages Open VSX at the pinned version and passes the provenance at install", async () => {
    openVsx.getPlugin.mockResolvedValueOnce({ manifest: { id: "x" } })
    const resolution = await resolveCogpackMember(
      member({
        kind: "openvsx",
        namespace: "acme",
        name: "x",
        version: "3.0.0",
        sha256: "a".repeat(64),
      }),
      undefined
    )
    const deps = createOpenVsxInstallClient.mock.calls[0][0] as {
      requestedVersion: string
      viaCogpack?: unknown
    }
    expect(deps.requestedVersion).toBe("3.0.0")
    expect(deps.viaCogpack).toBeUndefined()
    await resolution.install!({ viaCogpack })
    expect(deps.viaCogpack).toEqual(viaCogpack)
    expect(openVsx.installPlugin).toHaveBeenCalledWith("x", "3.0.0")
  })

  it("installs git at the commit and hands its capabilities back for review", async () => {
    installFromGit.mockResolvedValueOnce({ manifest: { id: "x" }, authorFingerprint: "fp" })
    const resolution = await resolveCogpackMember(
      member({ kind: "git", url: "https://g/x.git", commit: SHA }),
      undefined
    )
    expect(resolution.manifest).toBeUndefined()
    await expect(resolution.install!({ viaCogpack })).resolves.toEqual({
      grantToReview: { manifest: { id: "x" }, authorFingerprint: "fp" },
    })
    expect(installFromGit).toHaveBeenCalledWith({
      repoUrl: "https://g/x.git",
      commit: SHA,
      viaCogpack,
    })
  })
})

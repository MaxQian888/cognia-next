/** @jest-environment jsdom */
/**
 * Tests for the HTTP-URL WASM plugin installer.
 */

import "fake-indexeddb/auto"

const invokeMock = jest.fn()

jest.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}))

import { installFromUrl, previewBundleManifest, isPublisherKeyTrusted } from "./http-installer"
import { getDb } from "@/lib/db/schema"

function setTauri(present: boolean) {
  if (present) {
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      get: () => ({}),
    })
  } else {
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
  }
}

const baseManifest = {
  id: "demo.wasm",
  name: "Demo",
  version: "0.1.0",
  description: "x",
  type: "wasm" as const,
  capabilities: [],
  wasmMain: "main.wasm",
  wasm: { apiVersion: "0.1.0" },
  permissions: [],
  author: {
    name: "Alice",
    email: "alice@example.com",
    publicKey: "AAA=",
  },
}

beforeEach(async () => {
  invokeMock.mockReset()
  setTauri(true)
  const db = getDb()
  await db.trustedPublishers.clear()
})

describe("installFromUrl", () => {
  it("throws when invoked from browser mode", async () => {
    setTauri(false)
    await expect(installFromUrl({ bundleUrl: "https://example.com/p.zip" })).rejects.toThrow(
      /Tauri desktop runtime/
    )
  })

  it("rejects when signatureUrl is provided without an expected public key", async () => {
    await expect(
      installFromUrl({
        bundleUrl: "https://example.com/p.zip",
        signatureUrl: "https://example.com/p.zip.sig",
      })
    ).rejects.toThrow(/expectedPublicKeyBase64 is required/)
  })

  it("rejects when requireSignature is true but no signatureUrl provided", async () => {
    await expect(
      installFromUrl({
        bundleUrl: "https://example.com/p.zip",
        requireSignature: true,
      })
    ).rejects.toThrow(/signature URL is required/)
  })

  it("invokes plugin_wasm_install_from_url and returns the manifest + path", async () => {
    invokeMock.mockResolvedValueOnce({
      manifest: baseManifest,
      path: "/plugins/demo.wasm",
      source: "marketplace",
      installRootKind: "installed",
      signatureVerified: true,
      authorPublicKey: "AAA=",
      authorFingerprint: "9f3a",
    })
    const out = await installFromUrl({
      bundleUrl: "https://example.com/p.zip",
      signatureUrl: "https://example.com/p.zip.sig",
      expectedPublicKeyBase64: "AAA=",
    })
    expect(out.manifest.id).toBe("demo.wasm")
    expect(out.signatureVerified).toBe(true)
    expect(out.authorFingerprint).toBe("9f3a")
    expect(invokeMock).toHaveBeenCalledWith("plugin_wasm_install_from_url", {
      bundleUrl: "https://example.com/p.zip",
      signatureUrl: "https://example.com/p.zip.sig",
      expectedPublicKeyBase64: "AAA=",
      previewOnly: false,
      deferCommit: false,
      expectedBundleSha256: null,
    })
  })

  it("records the publisher in the trust ledger after a verified install", async () => {
    invokeMock.mockResolvedValueOnce({
      manifest: baseManifest,
      path: "/plugins/demo.wasm",
      source: "marketplace",
      installRootKind: "installed",
      signatureVerified: true,
      authorPublicKey: "AAA=",
      authorFingerprint: "9f3a",
    })
    await installFromUrl({
      bundleUrl: "https://example.com/p.zip",
      signatureUrl: "https://example.com/p.zip.sig",
      expectedPublicKeyBase64: "AAA=",
    })
    expect(await isPublisherKeyTrusted("AAA=")).toBe(true)
  })

  it("does not record publisher on an unverified install", async () => {
    invokeMock.mockResolvedValueOnce({
      manifest: baseManifest,
      path: "/plugins/demo.wasm",
      source: "marketplace",
      installRootKind: "installed",
      signatureVerified: false,
      authorPublicKey: "AAA=",
      authorFingerprint: "9f3a",
    })
    await installFromUrl({ bundleUrl: "https://example.com/p.zip" })
    expect(await isPublisherKeyTrusted("AAA=")).toBe(false)
  })
})

describe("previewBundleManifest", () => {
  it("calls the Rust installer without recording a publisher", async () => {
    invokeMock.mockResolvedValueOnce({
      manifest: baseManifest,
      path: "/plugins/demo.wasm",
      source: "marketplace",
      installRootKind: "installed",
      signatureVerified: true,
      authorPublicKey: "AAA=",
      authorFingerprint: "9f3a",
    })
    const preview = await previewBundleManifest({
      bundleUrl: "https://example.com/p.zip",
      signatureUrl: "https://example.com/p.zip.sig",
      expectedPublicKeyBase64: "AAA=",
    })
    expect(preview.manifest.id).toBe("demo.wasm")
    expect(invokeMock).toHaveBeenCalledWith(
      "plugin_wasm_install_from_url",
      expect.objectContaining({ previewOnly: true })
    )
    // Preview should NOT trust the publisher.
    expect(await isPublisherKeyTrusted("AAA=")).toBe(false)
  })
})

describe("isPublisherKeyTrusted", () => {
  it("returns false for empty / undefined keys", async () => {
    expect(await isPublisherKeyTrusted()).toBe(false)
    expect(await isPublisherKeyTrusted("")).toBe(false)
  })
})

describe("preview integrity and verified signer", () => {
  it("pins installation to the preview digest", async () => {
    const bundleSha256 = "a".repeat(64)
    invokeMock.mockResolvedValueOnce({
      manifest: baseManifest,
      path: "/plugins/demo.wasm",
      signatureVerified: false,
      bundleSha256,
    })
    const result = await installFromUrl({
      bundleUrl: "https://example.com/p.zip",
      expectedBundleSha256: bundleSha256,
    })
    expect(result.bundleSha256).toBe(bundleSha256)
    expect(invokeMock).toHaveBeenCalledWith(
      "plugin_wasm_install_from_url",
      expect.objectContaining({ expectedBundleSha256: bundleSha256, previewOnly: false })
    )
  })

  it("never trusts a manifest author substituted for the actual signer", async () => {
    invokeMock.mockResolvedValueOnce({
      manifest: baseManifest,
      path: "/plugins/demo.wasm",
      signatureVerified: true,
      authorPublicKey: "OTHER=",
      authorFingerprint: "ff",
    })
    await expect(
      installFromUrl({
        bundleUrl: "https://example.com/p.zip",
        signatureUrl: "https://example.com/p.sig",
        expectedPublicKeyBase64: "AAA=",
      })
    ).rejects.toThrow(/verified publisher/)
    expect(await getDb().trustedPublishers.count()).toBe(0)
  })

  it("preserves trust state when the backend rejects changed bytes", async () => {
    invokeMock.mockRejectedValueOnce(new Error("bundle checksum changed"))
    await expect(
      installFromUrl({
        bundleUrl: "https://example.com/p.zip",
        expectedBundleSha256: "a".repeat(64),
      })
    ).rejects.toThrow("bundle checksum changed")
    expect(await getDb().trustedPublishers.count()).toBe(0)
  })
})

it("discards a staged response that did not verify the required signature", async () => {
  invokeMock.mockResolvedValueOnce({
    manifest: { id: "test.plugin" },
    path: "/plugins/test.plugin",
    signatureVerified: false,
    bundleSha256: "a".repeat(64),
    transactionId: "stage",
  })
  await expect(
    installFromUrl({
      bundleUrl: "https://example.com/p.zip",
      signatureUrl: "https://example.com/p.sig",
      expectedPublicKeyBase64: "expected",
      deferCommit: true,
    })
  ).rejects.toThrow("verified publisher")
  expect(invokeMock).toHaveBeenLastCalledWith("plugin_discard_staged_update", {
    pluginId: "test.plugin",
    transactionId: "stage",
  })
})

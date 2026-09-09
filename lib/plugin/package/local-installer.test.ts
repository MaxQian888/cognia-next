/** @jest-environment jsdom */
/**
 * Tests for the local-file WASM plugin installer.
 */

import "fake-indexeddb/auto"

const invokeMock = jest.fn()

jest.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}))

import { installFromLocalFile } from "./local-installer"
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

describe("installFromLocalFile", () => {
  it("throws when invoked from browser mode", async () => {
    setTauri(false)
    await expect(installFromLocalFile({ bundlePath: "/tmp/p.zip" })).rejects.toThrow(
      /Tauri desktop runtime/
    )
  })

  it("rejects a signature with no key, and a key with no signature", async () => {
    await expect(
      installFromLocalFile({ bundlePath: "/tmp/p.zip", signatureBase64: "sig" })
    ).rejects.toThrow(/must be provided together/)
    await expect(
      installFromLocalFile({ bundlePath: "/tmp/p.zip", expectedPublicKeyBase64: "AAA=" })
    ).rejects.toThrow(/must be provided together/)
    expect(invokeMock).not.toHaveBeenCalled()
  })

  // The whole point of this module. The button it serves used to reach
  // `plugin_install`, which unpacks nothing and takes different arguments
  // entirely, so it could not succeed under any input. Pin the command NAME and
  // the ARGUMENT SHAPE: a call-count assertion passed happily while the call
  // was unusable.
  it("invokes plugin_wasm_install_from_file with the arguments the host declares", async () => {
    invokeMock.mockResolvedValueOnce({
      manifest: baseManifest,
      path: "/plugins/demo.wasm",
      source: "local",
      installRootKind: "installed",
      signatureVerified: false,
    })

    const result = await installFromLocalFile({ bundlePath: "/tmp/p.zip" })

    expect(invokeMock).toHaveBeenCalledWith("plugin_wasm_install_from_file", {
      bundlePath: "/tmp/p.zip",
      signatureBase64: null,
      expectedPublicKeyBase64: null,
    })
    expect(result.manifest.id).toBe("demo.wasm")
    expect(result.path).toBe("/plugins/demo.wasm")
    expect(result.signatureVerified).toBe(false)
  })

  it("records the publisher only once a signature actually verified", async () => {
    const db = getDb()

    invokeMock.mockResolvedValueOnce({
      manifest: baseManifest,
      path: "/plugins/demo.wasm",
      source: "local",
      installRootKind: "installed",
      signatureVerified: false,
      authorPublicKey: "AAA=",
      authorFingerprint: "ff",
    })
    await installFromLocalFile({ bundlePath: "/tmp/p.zip" })
    expect(await db.trustedPublishers.count()).toBe(0)

    invokeMock.mockResolvedValueOnce({
      manifest: baseManifest,
      path: "/plugins/demo.wasm",
      source: "local",
      installRootKind: "installed",
      signatureVerified: true,
      authorPublicKey: "AAA=",
      authorFingerprint: "ff",
    })
    await installFromLocalFile({
      bundlePath: "/tmp/p.zip",
      signatureBase64: "sig",
      expectedPublicKeyBase64: "AAA=",
    })
    expect(await db.trustedPublishers.count()).toBe(1)
  })
})

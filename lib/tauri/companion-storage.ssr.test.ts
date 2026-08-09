// SSR guard for the localStorage-backed companion storage, split out of
// `companion-storage.test.ts`: that file is jsdom-docblocked, and from Node 26
// on jsdom's `window` is non-configurable, so `delete globalThis.window`
// throws. This file runs in the `node` project, where there is genuinely no
// window — the real shape of the branch being asserted.
import { CompanionConfig, LocalStorageCompanionStorage } from "./companion-storage"

const MOCK: CompanionConfig = {
  baseUrl: "https://192.168.1.42:7890",
  devicePrivateKeyJwk: { kty: "EC", crv: "P-256", d: "device-key" },
  deviceKeyThumbprint: "thumbprint",
  deviceId: "device-abc",
  serverVersion: "0.1.0",
}

describe("LocalStorageCompanionStorage without a window (SSR)", () => {
  it("has no window to begin with", () => {
    expect(typeof window).toBe("undefined")
  })

  it("treats SSR as empty and makes writes no-ops", async () => {
    const storage = new LocalStorageCompanionStorage()
    expect(await storage.load()).toBeNull()
    await expect(storage.save(MOCK)).resolves.toBeUndefined()
    await expect(storage.clear()).resolves.toBeUndefined()
    expect(await storage.load()).toBeNull()
  })
})

import { createTauriCloudflaredSpawn } from "./cloudflared-tauri"

jest.mock("@/lib/tauri", () => ({
  isTauri: () => mockIsTauri,
}))

let mockIsTauri = false

beforeEach(() => {
  mockIsTauri = false
})

describe("createTauriCloudflaredSpawn", () => {
  it("rejects in web mode (no Tauri)", async () => {
    mockIsTauri = false
    const spawn = createTauriCloudflaredSpawn()
    await expect(spawn(["tunnel", "--url", "http://127.0.0.1:1"])).rejects.toThrow(/desktop-only/)
  })

  it("rejects when the shell plugin import fails (plugin not installed)", async () => {
    mockIsTauri = true
    const spawn = createTauriCloudflaredSpawn()
    // @tauri-apps/plugin-shell is not actually installed in the jest env,
    // so the dynamic import should throw and the factory should surface a
    // clear install-required message.
    await expect(spawn(["tunnel", "--url", "http://127.0.0.1:1"])).rejects.toThrow(
      /plugin-shell is not installed/
    )
  })

  it("honors the binaryName override", async () => {
    mockIsTauri = false
    const spawn = createTauriCloudflaredSpawn({ binaryName: "cloudflared-custom" })
    // Web-mode path still rejects with desktop-only — but the factory itself
    // accepted the override without throwing synchronously.
    await expect(spawn([])).rejects.toThrow(/desktop-only/)
  })
})

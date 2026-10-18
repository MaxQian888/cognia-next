import { defineRemoteDesktopProvider } from "./define-remote-desktop-provider"

describe("defineRemoteDesktopProvider", () => {
  it("returns the provider definition unchanged", () => {
    const viewer = { kind: "webview" as const, viewId: "viewer" }
    const def = defineRemoteDesktopProvider({
      id: "vnc",
      name: "VNC",
      integrationMode: "embedded",
      adapter: "vnc",
      defaultPort: 5900,
      capabilities: { viewOnlyPassword: true },
      viewer,
    })
    expect(def.id).toBe("vnc")
    expect(def.viewer).toBe(viewer)
  })
})

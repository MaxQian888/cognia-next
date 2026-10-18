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

  it("keeps a web console or external app definition as declared", () => {
    const consoleDef = defineRemoteDesktopProvider({
      id: "guac",
      name: "Guacamole",
      integrationMode: "web-console",
      consoleProfile: "guacamole",
    })
    expect(consoleDef.consoleProfile).toBe("guacamole")
    const app = defineRemoteDesktopProvider({
      id: "rd",
      name: "RustDesk",
      integrationMode: "external-app",
      launcher: "rustdesk",
    })
    expect(app.launcher).toBe("rustdesk")
  })
})

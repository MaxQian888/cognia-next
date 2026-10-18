import type { RemoteDesktopBinding, RemoteDesktopProbeRequest } from "./types"

describe("remote desktop wire types", () => {
  it("never carries a credential back from the Host", () => {
    const binding: RemoteDesktopBinding = {
      id: "b",
      providerId: "cognia.remote-desktop-vnc",
      adapter: "vnc",
      priority: 0,
      enabled: true,
      endpoint: {
        host: "nas.local",
        port: 5900,
        pinnedIp: "192.168.1.20",
        class: "private",
        confirmedAt: 1,
      },
      viewOnly: true,
      config: null,
      hasControlCredential: true,
      hasViewCredential: true,
    }
    expect(Object.keys(binding).some((key) => /password|secret|value/i.test(key))).toBe(false)
  })

  it("tags probe requests the way the Host's serde enum expects", () => {
    const draft: RemoteDesktopProbeRequest = {
      kind: "draft",
      host: "nas.local",
      port: 5900,
      adapter: "vnc",
    }
    expect(draft.kind).toBe("draft")
  })
})

/**
 * @jest-environment jsdom
 */
import { requestMdnsPermission } from "./mdns-permission"

describe("requestMdnsPermission", () => {
  it("returns granted when the plugin lacks requestPermissions (Android path)", async () => {
    const out = await requestMdnsPermission(async () => ({}))
    expect(out).toEqual({ kind: "granted" })
  })

  it("forwards the plugin's localNetwork outcome verbatim", async () => {
    const out = await requestMdnsPermission(async () => ({
      requestPermissions: async () => ({ localNetwork: "denied" }),
    }))
    expect(out).toEqual({ kind: "denied" })
  })

  it("returns unsupported when the loader rejects", async () => {
    const out = await requestMdnsPermission(async () => {
      throw new Error("not on mobile")
    })
    expect(out).toEqual({ kind: "unsupported" })
  })

  it("returns denied when the plugin throws mid-request", async () => {
    const out = await requestMdnsPermission(async () => ({
      requestPermissions: async () => {
        throw new Error("service unavailable")
      },
    }))
    expect(out).toEqual({ kind: "denied" })
  })

  it("maps prompt-state correctly when the plugin reports it", async () => {
    const out = await requestMdnsPermission(async () => ({
      requestPermissions: async () => ({ localNetwork: "prompt" }),
    }))
    expect(out).toEqual({ kind: "prompt" })
  })
})

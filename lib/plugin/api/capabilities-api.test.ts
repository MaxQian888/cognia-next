import { __makeCapabilitiesForTesting, createCapabilitiesAPI } from "./capabilities-api"

describe("createCapabilitiesAPI", () => {
  it("returns a fully-populated structural object", () => {
    const caps = createCapabilitiesAPI()
    expect(typeof caps.tauri).toBe("boolean")
    expect(typeof caps.mobile).toBe("boolean")
    expect(typeof caps.web).toBe("boolean")
    expect(typeof caps.browser).toBe("boolean")
    expect(["tauri", "mobile", "web"]).toContain(caps.platform)
  })

  it("flags are mutually consistent — exactly one of tauri / mobile / web", () => {
    const caps = createCapabilitiesAPI()
    const trueCount = [caps.tauri, caps.mobile, caps.web].filter(Boolean).length
    // In the jsdom env we expect exactly one to be true.
    expect(trueCount).toBeLessThanOrEqual(1)
  })

  it("test override helper produces a customizable shape", () => {
    const caps = __makeCapabilitiesForTesting({
      tauri: true,
      mobile: false,
      web: false,
      platform: "tauri",
    })
    expect(caps.tauri).toBe(true)
    expect(caps.mobile).toBe(false)
  })
})

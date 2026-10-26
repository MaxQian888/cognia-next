import { APP_VERSION, createPluginLogger, readHostCapabilities } from "./host-environment"

describe("api/host-environment", () => {
  it("declares the unhosted placeholder version; the host's subpath loader supplies the real one", () => {
    expect(APP_VERSION).toBe("0.0.0")
  })

  it("re-exports the host-environment runtime helpers", () => {
    expect(typeof readHostCapabilities).toBe("function")
    expect(typeof createPluginLogger).toBe("function")
  })
})

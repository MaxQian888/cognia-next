import { hostInstallerEnabled } from "./feature-flag"

describe("hostInstallerEnabled", () => {
  it("is off in a production build unless the build turns it on", () => {
    expect(hostInstallerEnabled({ nodeEnv: "production" })).toBe(false)
    expect(hostInstallerEnabled({ flag: "", nodeEnv: "production" })).toBe(false)
    expect(hostInstallerEnabled({ flag: "1", nodeEnv: "production" })).toBe(true)
    expect(hostInstallerEnabled({ flag: " ON ", nodeEnv: "production" })).toBe(true)
    expect(hostInstallerEnabled({ flag: "true", nodeEnv: "test" })).toBe(true)
  })

  it("is on in next dev unless switched off", () => {
    expect(hostInstallerEnabled({ nodeEnv: "development" })).toBe(true)
    expect(hostInstallerEnabled({ flag: "0", nodeEnv: "development" })).toBe(false)
    expect(hostInstallerEnabled({ flag: "off", nodeEnv: "development" })).toBe(false)
  })

  it("is off under test unless a test turns it on", () => {
    expect(hostInstallerEnabled({ nodeEnv: "test" })).toBe(false)
    expect(hostInstallerEnabled()).toBe(false)
  })
})

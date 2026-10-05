import { accountSyncEnabled } from "./feature-flag"

describe("accountSyncEnabled", () => {
  it("is off in a production build unless the build turns it on", () => {
    expect(accountSyncEnabled({ nodeEnv: "production" })).toBe(false)
    expect(accountSyncEnabled({ flag: "", nodeEnv: "production" })).toBe(false)
    expect(accountSyncEnabled({ flag: "1", nodeEnv: "production" })).toBe(true)
    expect(accountSyncEnabled({ flag: " ON ", nodeEnv: "production" })).toBe(true)
    expect(accountSyncEnabled({ flag: "true", nodeEnv: "test" })).toBe(true)
  })

  it("is on in next dev unless switched off", () => {
    expect(accountSyncEnabled({ nodeEnv: "development" })).toBe(true)
    expect(accountSyncEnabled({ flag: "0", nodeEnv: "development" })).toBe(false)
    expect(accountSyncEnabled({ flag: "off", nodeEnv: "development" })).toBe(false)
  })

  it("is off under test unless a test turns it on", () => {
    expect(accountSyncEnabled({ nodeEnv: "test" })).toBe(false)
  })
})

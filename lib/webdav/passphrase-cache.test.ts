import {
  setSyncPassphrase,
  getSyncPassphrase,
  hasSyncPassphrase,
  clearSyncPassphrase,
} from "./passphrase-cache"

afterEach(() => clearSyncPassphrase())

describe("passphrase-cache", () => {
  it("starts empty", () => {
    expect(hasSyncPassphrase()).toBe(false)
    expect(getSyncPassphrase()).toBeNull()
  })

  it("stores and reads a passphrase", () => {
    setSyncPassphrase("secret")
    expect(hasSyncPassphrase()).toBe(true)
    expect(getSyncPassphrase()).toBe("secret")
  })

  it("treats empty string as cleared", () => {
    setSyncPassphrase("x")
    setSyncPassphrase("")
    expect(hasSyncPassphrase()).toBe(false)
  })

  it("clears", () => {
    setSyncPassphrase("x")
    clearSyncPassphrase()
    expect(getSyncPassphrase()).toBeNull()
  })
})

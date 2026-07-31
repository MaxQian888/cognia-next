import { ACCOUNT_STATUS_LABEL_KEY, accountStatus } from "./account-status"

describe("accountStatus", () => {
  it("marks the active account active (even when also the unlocked one)", () => {
    expect(accountStatus("a", "a", "a")).toBe("active")
    expect(accountStatus("a", "a", null)).toBe("active")
  })

  it("marks a verified-but-inactive account unlocked", () => {
    expect(accountStatus("b", "a", "b")).toBe("unlocked")
  })

  it("marks everything else locked", () => {
    expect(accountStatus("c", "a", "b")).toBe("locked")
    expect(accountStatus("c", null, null)).toBe("locked")
  })
})

describe("ACCOUNT_STATUS_LABEL_KEY", () => {
  it("maps every status to a label key", () => {
    expect(ACCOUNT_STATUS_LABEL_KEY.active).toBe("statusActive")
    expect(ACCOUNT_STATUS_LABEL_KEY.unlocked).toBe("statusUnlocked")
    expect(ACCOUNT_STATUS_LABEL_KEY.locked).toBe("statusLocked")
  })
})

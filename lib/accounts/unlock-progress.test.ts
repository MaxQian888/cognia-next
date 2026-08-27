/** @jest-environment jsdom */
import {
  publishUnlockStage,
  subscribeUnlockProgress,
  unlockStagesFor,
  type AccountUnlockProgressDetail,
} from "./unlock-progress"

describe("unlockStagesFor", () => {
  it("includes the runtime-target step only on Browser Vault runtimes", () => {
    expect(unlockStagesFor(true)).toEqual([
      "verifying",
      "preparing-runtime",
      "opening-database",
      "activating",
    ])
  })

  it("omits the runtime-target step on the desktop host, which never runs it", () => {
    expect(unlockStagesFor(false)).toEqual(["verifying", "opening-database", "activating"])
  })

  it("never lists a terminal stage as work to wait on", () => {
    for (const usesVault of [true, false]) {
      expect(unlockStagesFor(usesVault)).not.toContain("ready")
      expect(unlockStagesFor(usesVault)).not.toContain("failed")
    }
  })
})

describe("unlock progress signal", () => {
  it("delivers every published stage to subscribers", () => {
    const seen: AccountUnlockProgressDetail[] = []
    const unsubscribe = subscribeUnlockProgress((detail) => seen.push(detail))
    publishUnlockStage("acct_alpha", "verifying")
    publishUnlockStage("acct_alpha", "opening-database")
    publishUnlockStage("acct_alpha", "ready")
    unsubscribe()
    expect(seen).toEqual([
      { accountId: "acct_alpha", stage: "verifying" },
      { accountId: "acct_alpha", stage: "opening-database" },
      { accountId: "acct_alpha", stage: "ready" },
    ])
  })

  it("stops delivering after unsubscribe", () => {
    const seen: AccountUnlockProgressDetail[] = []
    subscribeUnlockProgress((detail) => seen.push(detail))()
    publishUnlockStage("acct_alpha", "verifying")
    expect(seen).toEqual([])
  })

  it("ignores an event dispatched without a detail payload", () => {
    const seen: AccountUnlockProgressDetail[] = []
    const unsubscribe = subscribeUnlockProgress((detail) => seen.push(detail))
    window.dispatchEvent(new CustomEvent("cognia:account-unlock-progress"))
    unsubscribe()
    expect(seen).toEqual([])
  })
})

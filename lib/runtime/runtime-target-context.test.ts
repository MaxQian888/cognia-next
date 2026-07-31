import {
  clearActiveRuntimeTargetContext,
  getActiveRuntimeTargetContext,
  setActiveRuntimeTargetContext,
} from "./runtime-target-context"

afterEach(() => {
  clearActiveRuntimeTargetContext()
})

it("tracks the exact account and target used by queues and transports", () => {
  setActiveRuntimeTargetContext("acct_alpha", "desktop-studio")

  expect(getActiveRuntimeTargetContext()).toEqual({
    accountId: "acct_alpha",
    targetId: "desktop-studio",
  })
})

it("clears both dimensions atomically", () => {
  setActiveRuntimeTargetContext("acct_alpha", "desktop-studio")
  clearActiveRuntimeTargetContext()

  expect(getActiveRuntimeTargetContext()).toBeNull()
})

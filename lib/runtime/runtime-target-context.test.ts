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
    routingGeneration: expect.any(Number),
  })
})

it("keeps a stable generation for one route and advances it on target change", () => {
  setActiveRuntimeTargetContext("acct_alpha", "desktop-studio")
  const first = getActiveRuntimeTargetContext()!
  setActiveRuntimeTargetContext("acct_alpha", "desktop-studio")
  expect(getActiveRuntimeTargetContext()!.routingGeneration).toBe(first.routingGeneration)

  setActiveRuntimeTargetContext("acct_alpha", "desktop-cloud")
  expect(getActiveRuntimeTargetContext()!.routingGeneration).toBeGreaterThan(
    first.routingGeneration
  )
})

it("clears both dimensions atomically", () => {
  setActiveRuntimeTargetContext("acct_alpha", "desktop-studio")
  clearActiveRuntimeTargetContext()

  expect(getActiveRuntimeTargetContext()).toBeNull()
})

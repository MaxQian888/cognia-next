import {
  clearActiveRuntimeTargetContext,
  getActiveRuntimeTargetContext,
  getRuntimeTargetScopeKey,
  setActiveRuntimeTargetContext,
  subscribeRuntimeTargetContext,
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

it("notifies scope owners for direct target, generation and lock changes only", () => {
  const changes: Array<ReturnType<typeof getActiveRuntimeTargetContext>> = []
  const unsubscribe = subscribeRuntimeTargetContext(() =>
    changes.push(getActiveRuntimeTargetContext())
  )
  setActiveRuntimeTargetContext("acct_alpha", "desktop-studio", 100)
  setActiveRuntimeTargetContext("acct_alpha", "desktop-studio", 100)
  setActiveRuntimeTargetContext("acct_alpha", "desktop-studio", 101)
  setActiveRuntimeTargetContext("acct_alpha", "desktop-cloud", 102)
  clearActiveRuntimeTargetContext()
  clearActiveRuntimeTargetContext()
  unsubscribe()
  setActiveRuntimeTargetContext("acct_alpha", "desktop-studio", 103)
  expect(changes).toEqual([
    { accountId: "acct_alpha", targetId: "desktop-studio", routingGeneration: 100 },
    { accountId: "acct_alpha", targetId: "desktop-studio", routingGeneration: 101 },
    { accountId: "acct_alpha", targetId: "desktop-cloud", routingGeneration: 102 },
    null,
  ])
})

it("exposes a stable primitive snapshot that distinguishes routing generations", () => {
  setActiveRuntimeTargetContext("acct_alpha", "host-one", 100)
  const key = getRuntimeTargetScopeKey()
  expect(getRuntimeTargetScopeKey()).toBe(key)
  setActiveRuntimeTargetContext("acct_alpha", "host-one", 101)
  expect(getRuntimeTargetScopeKey()).not.toBe(key)
})

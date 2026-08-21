import {
  registerRuntimeTargetTransitionParticipant,
  registerRuntimeTargetSubscriptionStopper,
  runRuntimeTargetTransitionPhase,
  stopRuntimeTargetSubscriptions,
} from "./runtime-target-lifecycle"

afterEach(async () => {
  await stopRuntimeTargetSubscriptions()
})

it("stops the active target subscriptions exactly once", async () => {
  const stop = jest.fn()
  registerRuntimeTargetSubscriptionStopper(stop)

  await stopRuntimeTargetSubscriptions()
  await stopRuntimeTargetSubscriptions()

  expect(stop).toHaveBeenCalledTimes(1)
})

it("does not let an old unregister callback remove a newer stopper", async () => {
  const stopOld = jest.fn()
  const stopCurrent = jest.fn()
  const unregisterOld = registerRuntimeTargetSubscriptionStopper(stopOld)
  registerRuntimeTargetSubscriptionStopper(stopCurrent)

  unregisterOld()
  await stopRuntimeTargetSubscriptions()

  expect(stopOld).not.toHaveBeenCalled()
  expect(stopCurrent).toHaveBeenCalledTimes(1)
})

it("runs composable participants in phase and priority order exactly once", async () => {
  const order: string[] = []
  const unregisterLate = registerRuntimeTargetTransitionParticipant({
    id: "late-capture",
    phase: "finalize-captures",
    priority: 20,
    run: async () => {
      order.push("capture-late")
    },
  })
  const unregisterEarly = registerRuntimeTargetTransitionParticipant({
    id: "early-capture",
    phase: "finalize-captures",
    priority: 10,
    run: async () => {
      order.push("capture-early")
    },
  })
  const unregisterRelease = registerRuntimeTargetTransitionParticipant({
    id: "release-perf",
    phase: "release-subscriptions",
    priority: 0,
    run: async () => {
      order.push("release")
    },
  })

  await runRuntimeTargetTransitionPhase("finalize-captures", {
    accountId: "account-a",
    fromTargetId: "target-a",
    toTargetId: "target-b",
  })
  await runRuntimeTargetTransitionPhase("release-subscriptions", {
    accountId: "account-a",
    fromTargetId: "target-a",
    toTargetId: "target-b",
  })

  expect(order).toEqual(["capture-early", "capture-late", "release"])
  unregisterLate()
  unregisterEarly()
  unregisterRelease()
})

it("keeps same-phase participants composable instead of replacing the previous one", async () => {
  const first = jest.fn()
  const second = jest.fn()
  const unregisterFirst = registerRuntimeTargetTransitionParticipant({
    id: "first",
    phase: "release-subscriptions",
    priority: 1,
    run: first,
  })
  const unregisterSecond = registerRuntimeTargetTransitionParticipant({
    id: "second",
    phase: "release-subscriptions",
    priority: 2,
    run: second,
  })

  await runRuntimeTargetTransitionPhase("release-subscriptions", {
    accountId: "account-a",
    fromTargetId: "target-a",
    toTargetId: "target-b",
  })

  expect(first).toHaveBeenCalledTimes(1)
  expect(second).toHaveBeenCalledTimes(1)
  unregisterFirst()
  unregisterSecond()
})

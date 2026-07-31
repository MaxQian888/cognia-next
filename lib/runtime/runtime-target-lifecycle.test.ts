import {
  registerRuntimeTargetSubscriptionStopper,
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

import {
  registerMobileHostBindingController,
  restartMobileHostBindings,
} from "./mobile-host-binding-lifecycle"

it("coalesces concurrent restarts into one ordered stop/start", async () => {
  const order: string[] = []
  let releaseStop: (() => void) | undefined
  const unregister = registerMobileHostBindingController({
    stop: async () => {
      order.push("stop")
      await new Promise<void>((resolve) => {
        releaseStop = resolve
      })
    },
    start: async () => {
      order.push("start")
    },
  })

  const first = restartMobileHostBindings()
  const second = restartMobileHostBindings()
  expect(second).toBe(first)
  expect(order).toEqual(["stop"])

  releaseStop?.()
  await Promise.all([first, second])
  expect(order).toEqual(["stop", "start"])
  unregister()
})

it("does not start a controller that was unregistered during teardown", async () => {
  let releaseStop: (() => void) | undefined
  const start = jest.fn().mockResolvedValue(undefined)
  const unregister = registerMobileHostBindingController({
    stop: () =>
      new Promise<void>((resolve) => {
        releaseStop = resolve
      }),
    start,
  })

  const restarting = restartMobileHostBindings()
  unregister()
  releaseStop?.()
  await restarting

  expect(start).not.toHaveBeenCalled()
})

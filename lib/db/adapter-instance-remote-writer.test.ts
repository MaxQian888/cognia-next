import {
  completeAdapterInstanceCreate,
  hostAdapterInstanceWriter,
  setAdapterInstanceRemoteWriter,
  type AdapterInstanceRemoteWriter,
} from "./adapter-instance-remote-writer"

function writer(applies: boolean) {
  return {
    applies: () => applies,
    create: jest.fn(),
    configure: jest.fn(),
    remove: jest.fn(),
    completeCreate: jest.fn(async () => undefined),
  } satisfies AdapterInstanceRemoteWriter
}

it("answers the installed writer only when it applies, and restores the previous one", async () => {
  expect(hostAdapterInstanceWriter()).toBeNull()
  const host = writer(true)
  const restoreHost = setAdapterInstanceRemoteWriter(host)
  expect(hostAdapterInstanceWriter()).toBe(host)
  await completeAdapterInstanceCreate("a")
  expect(host.completeCreate).toHaveBeenCalledWith("a")

  const idle = writer(false)
  const restoreIdle = setAdapterInstanceRemoteWriter(idle)
  expect(hostAdapterInstanceWriter()).toBeNull()
  await completeAdapterInstanceCreate("b")
  expect(idle.completeCreate).not.toHaveBeenCalled()

  restoreIdle()
  expect(hostAdapterInstanceWriter()).toBe(host)
  restoreHost()
  expect(hostAdapterInstanceWriter()).toBeNull()
})

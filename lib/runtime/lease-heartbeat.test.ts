import { startLeaseHeartbeat } from "./lease-heartbeat"

beforeEach(() => jest.useFakeTimers())
afterEach(() => jest.useRealTimers())

it("serializes renewals and stops after loss", async () => {
  let resolve!: (status: "renewed") => void
  const renew = jest
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r
        })
    )
    .mockResolvedValue("lost")
  const onLeaseLost = jest.fn()
  startLeaseHeartbeat({ renew, intervalMs: 10, onLeaseLost })
  await jest.advanceTimersByTimeAsync(100)
  expect(renew).toHaveBeenCalledTimes(1)
  resolve("renewed")
  await jest.advanceTimersByTimeAsync(10)
  expect(renew).toHaveBeenCalledTimes(2)
  expect(onLeaseLost).toHaveBeenCalledTimes(1)
  await jest.advanceTimersByTimeAsync(100)
  expect(renew).toHaveBeenCalledTimes(2)
})

it.each(["lost", "error"])("ignores late %s after stop", async (result) => {
  let finish!: () => void
  const renew = jest.fn(
    () =>
      new Promise<"lost">((resolve, reject) => {
        finish = () => (result === "lost" ? resolve("lost") : reject(new Error("offline")))
      })
  )
  const onLeaseLost = jest.fn()
  const onError = jest.fn()
  const stop = startLeaseHeartbeat({ renew, intervalMs: 10, onLeaseLost, onError })
  await jest.advanceTimersByTimeAsync(10)
  stop()
  finish()
  await jest.advanceTimersByTimeAsync(100)
  expect(onLeaseLost).not.toHaveBeenCalled()
  expect(onError).not.toHaveBeenCalled()
  expect(renew).toHaveBeenCalledTimes(1)
})

it("fails closed even if the error observer throws", async () => {
  const onLeaseLost = jest.fn()
  startLeaseHeartbeat({
    renew: async () => {
      throw new Error("storage")
    },
    intervalMs: 10,
    onError: () => {
      throw new Error("observer")
    },
    onLeaseLost,
  })
  await jest.advanceTimersByTimeAsync(100)
  expect(onLeaseLost).toHaveBeenCalledTimes(1)
})

import { startWorkSubmissionLeaseHeartbeat } from "./lease-heartbeat"

describe("work submission lease heartbeat", () => {
  beforeEach(() => jest.useFakeTimers())
  afterEach(() => jest.useRealTimers())

  it("renews serially until ownership is lost", async () => {
    const renew = jest.fn().mockResolvedValueOnce("renewed").mockResolvedValueOnce("closed")
    startWorkSubmissionLeaseHeartbeat("submission-1", "live-chat", {
      renew,
      intervalMs: 10,
      now: () => 100,
    })

    await jest.advanceTimersByTimeAsync(20)
    expect(renew).toHaveBeenCalledTimes(2)
    expect(renew).toHaveBeenCalledWith("submission-1", "live-chat", 100)
    await jest.advanceTimersByTimeAsync(20)
    expect(renew).toHaveBeenCalledTimes(2)
  })

  it("stops immediately when the owner completes the handoff", async () => {
    const renew = jest.fn().mockResolvedValue("renewed")
    const stop = startWorkSubmissionLeaseHeartbeat("submission-1", "live-chat", {
      renew,
      intervalMs: 10,
    })
    stop()
    await jest.advanceTimersByTimeAsync(20)
    expect(renew).not.toHaveBeenCalled()
  })

  it("fails closed when renewal reports lost ownership or throws", async () => {
    const onLeaseLost = jest.fn()
    const onError = jest.fn()
    const renew = jest.fn().mockResolvedValueOnce("lost").mockRejectedValueOnce(new Error("db"))
    startWorkSubmissionLeaseHeartbeat("submission-1", "live-chat", {
      renew,
      intervalMs: 10,
      onLeaseLost,
      onError,
    })
    await jest.advanceTimersByTimeAsync(10)
    expect(onLeaseLost).toHaveBeenCalledTimes(1)

    startWorkSubmissionLeaseHeartbeat("submission-2", "live-chat", {
      renew,
      intervalMs: 10,
      onLeaseLost,
      onError,
    })
    await jest.advanceTimersByTimeAsync(10)
    expect(onError).toHaveBeenCalledWith(expect.any(Error))
    expect(onLeaseLost).toHaveBeenCalledTimes(2)
  })

  it("does not abort a completed handoff when its pending renewal resolves late", async () => {
    let finish!: (status: "lost") => void
    const renew = jest.fn(
      () =>
        new Promise<"lost">((resolve) => {
          finish = resolve
        })
    )
    const onLeaseLost = jest.fn()
    const stop = startWorkSubmissionLeaseHeartbeat("submission-1", "live-chat", {
      renew,
      intervalMs: 10,
      onLeaseLost,
    })
    await jest.advanceTimersByTimeAsync(10)
    stop()
    finish("lost")
    await jest.advanceTimersByTimeAsync(100)
    expect(onLeaseLost).not.toHaveBeenCalled()
    expect(renew).toHaveBeenCalledTimes(1)
  })
})

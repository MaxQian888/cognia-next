import {
  HOST_RECOVERY_BACKOFF_MS,
  createWakeableSleep,
  hostRefusal,
  hostRetryDelayMs,
  jitteredBackoffMs,
  waitForHostManifest,
} from "./host-manifest-retry"

function refusalError(fields: Record<string, unknown>, message = "refused"): Error {
  return Object.assign(new Error(message), fields)
}

describe("hostRefusal", () => {
  it("reads code, retryable and a sane retryAfterMs off an error", () => {
    expect(
      hostRefusal(refusalError({ code: "rate_limited", retryable: true, retryAfterMs: 1500 }))
    ).toEqual({ code: "rate_limited", message: "refused", retryable: true, retryAfterMs: 1500 })
  })

  it("drops a missing, negative or non-finite retryAfterMs", () => {
    for (const retryAfterMs of [undefined, -1, Number.NaN, Number.POSITIVE_INFINITY, "5"]) {
      expect(
        hostRefusal(refusalError({ code: "busy", retryable: true, retryAfterMs }))
      ).not.toHaveProperty("retryAfterMs")
    }
  })

  it("stringifies a non-Error carrier and rejects anything without a verdict", () => {
    expect(hostRefusal({ code: "revoked", retryable: false })).toEqual({
      code: "revoked",
      message: "[object Object]",
      retryable: false,
    })
    expect(hostRefusal(null)).toBeNull()
    expect(hostRefusal("nope")).toBeNull()
    expect(hostRefusal(new Error("plain"))).toBeNull()
    expect(hostRefusal({ code: 1, retryable: true })).toBeNull()
    expect(hostRefusal({ code: "x", retryable: "yes" })).toBeNull()
  })
})

describe("backoff", () => {
  it("walks the schedule and stays on its last step", () => {
    const mid = () => 0.5
    expect(HOST_RECOVERY_BACKOFF_MS.map((_, i) => jitteredBackoffMs(i, mid))).toEqual([
      ...HOST_RECOVERY_BACKOFF_MS,
    ])
    expect(jitteredBackoffMs(99, mid)).toBe(30_000)
    expect(jitteredBackoffMs(-3, mid)).toBe(250)
  })

  it("jitters ±15%", () => {
    expect(jitteredBackoffMs(1, () => 0)).toBe(850)
    expect(jitteredBackoffMs(1, () => 1)).toBe(1150)
  })

  it("takes a positive Host-named wait and ignores zero or absent ones", () => {
    const mid = () => 0.5
    expect(hostRetryDelayMs(0, 7_000, mid)).toBe(7_000)
    expect(hostRetryDelayMs(2, 0, mid)).toBe(4_000)
    expect(hostRetryDelayMs(2, undefined, mid)).toBe(4_000)
  })
})

describe("waitForHostManifest", () => {
  const instantSleep = jest.fn(async (_ms: number) => undefined)
  beforeEach(() => instantSleep.mockClear())

  it("returns the first loaded value without sleeping", async () => {
    const load = jest.fn().mockResolvedValue("manifest")
    await expect(
      waitForHostManifest({ load, isCancelled: () => false, sleep: instantSleep })
    ).resolves.toEqual({ kind: "loaded", value: "manifest" })
    expect(instantSleep).not.toHaveBeenCalled()
  })

  it("retries transient failures on the schedule, reporting each one", async () => {
    const load = jest
      .fn()
      .mockRejectedValueOnce(new Error("no carrier"))
      .mockRejectedValueOnce(
        refusalError({ code: "rate_limited", retryable: true, retryAfterMs: 9 })
      )
      .mockRejectedValueOnce(refusalError({ code: "busy", retryable: true, retryAfterMs: 0 }))
      .mockResolvedValueOnce(true)
    const onRetry = jest.fn()
    const outcome = await waitForHostManifest({
      load,
      isCancelled: () => false,
      onRetry,
      sleep: instantSleep,
      random: () => 0.5,
    })
    expect(outcome).toEqual({ kind: "loaded", value: true })
    expect(instantSleep.mock.calls.map(([ms]) => ms)).toEqual([250, 9, 4_000])
    expect(onRetry.mock.calls.map(([retry]) => [retry.attempt, retry.delayMs])).toEqual([
      [0, 250],
      [1, 9],
      [2, 4_000],
    ])
    expect(onRetry.mock.calls[0][0].refusal).toBeNull()
    expect(onRetry.mock.calls[1][0].refusal).toMatchObject({ code: "rate_limited" })
  })

  it("stops on a non-retryable refusal", async () => {
    const error = refusalError({ code: "grant_revoked", retryable: false }, "revoked")
    const load = jest.fn().mockRejectedValue(error)
    const onRetry = jest.fn()
    await expect(
      waitForHostManifest({ load, isCancelled: () => false, onRetry, sleep: instantSleep })
    ).resolves.toEqual({
      kind: "refused",
      refusal: { code: "grant_revoked", message: "revoked", retryable: false },
      error,
    })
    expect(load).toHaveBeenCalledTimes(1)
    expect(onRetry).not.toHaveBeenCalled()
  })

  it("never loads once cancelled, and stops after a failure that lands post-cancel", async () => {
    const load = jest.fn().mockResolvedValue(true)
    await expect(
      waitForHostManifest({ load, isCancelled: () => true, sleep: instantSleep })
    ).resolves.toEqual({ kind: "cancelled" })
    expect(load).not.toHaveBeenCalled()

    let cancelled = false
    const failing = jest.fn(async () => {
      cancelled = true
      throw new Error("late")
    })
    const onRetry = jest.fn()
    await expect(
      waitForHostManifest({
        load: failing,
        isCancelled: () => cancelled,
        onRetry,
        sleep: instantSleep,
      })
    ).resolves.toEqual({ kind: "cancelled" })
    expect(onRetry).not.toHaveBeenCalled()
  })

  it("exits after a wait that ends in cancellation", async () => {
    let cancelled = false
    const load = jest.fn().mockRejectedValue(new Error("down"))
    const outcome = await waitForHostManifest({
      load,
      isCancelled: () => cancelled,
      sleep: async () => {
        cancelled = true
      },
    })
    expect(outcome).toEqual({ kind: "cancelled" })
    expect(load).toHaveBeenCalledTimes(1)
  })
})

describe("createWakeableSleep", () => {
  beforeEach(() => jest.useFakeTimers())
  afterEach(() => jest.useRealTimers())

  const settled = async (promise: Promise<void>) => {
    let done = false
    void promise.then(() => {
      done = true
    })
    await Promise.resolve()
    await Promise.resolve()
    return done
  }

  it("resolves when the timer elapses", async () => {
    const sleeper = createWakeableSleep()
    const wait = sleeper.sleep(1_000)
    jest.advanceTimersByTime(999)
    expect(await settled(wait)).toBe(false)
    jest.advanceTimersByTime(1)
    expect(await settled(wait)).toBe(true)
  })

  it("wake ends the current wait early and clears its timer", async () => {
    const sleeper = createWakeableSleep()
    const wait = sleeper.sleep(30_000)
    sleeper.wake()
    expect(await settled(wait)).toBe(true)
    expect(jest.getTimerCount()).toBe(0)
  })

  it("a wake with no wait in progress makes the next wait instant, once", async () => {
    const sleeper = createWakeableSleep()
    sleeper.wake()
    expect(await settled(sleeper.sleep(30_000))).toBe(true)
    expect(await settled(sleeper.sleep(30_000))).toBe(false)
  })

  it("dispose releases a waiter, clears the timer and makes later waits instant", async () => {
    const sleeper = createWakeableSleep()
    const wait = sleeper.sleep(30_000)
    sleeper.dispose()
    expect(await settled(wait)).toBe(true)
    expect(jest.getTimerCount()).toBe(0)
    sleeper.wake()
    expect(await settled(sleeper.sleep(30_000))).toBe(true)
    expect(jest.getTimerCount()).toBe(0)
  })
})

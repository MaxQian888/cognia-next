import { isRetryableTtsFailure, withTtsRetry } from "./retry"
import { getTTSError, type TTSResponse } from "./types"

const ok: TTSResponse = { success: true, audioData: new ArrayBuffer(8), mimeType: "audio/mpeg" }
const networkFail: TTSResponse = { success: false, error: getTTSError("network-error").message }
const apiFail: TTSResponse = { success: false, error: getTTSError("api-error").message }
const keyFail: TTSResponse = { success: false, error: getTTSError("api-key-missing").message }
const tooLong: TTSResponse = { success: false, error: getTTSError("text-too-long").message }

const noDelay = () => Promise.resolve()

describe("isRetryableTtsFailure", () => {
  it("retries transient network/api errors only (legacy string path)", () => {
    expect(isRetryableTtsFailure(networkFail)).toBe(true)
    expect(isRetryableTtsFailure(apiFail)).toBe(true)
    expect(isRetryableTtsFailure(keyFail)).toBe(false)
    expect(isRetryableTtsFailure(tooLong)).toBe(false)
    expect(isRetryableTtsFailure(ok)).toBe(false)
  })

  it("classifies api-error by HTTP status (W14) — permanent 4xx is not retried", () => {
    const at = (status: number): TTSResponse => ({
      success: false,
      error: "TTS API returned an error",
      errorType: "api-error",
      status,
    })
    // The exact bug: a permanent 401 was retried 3× like a transient 503.
    expect(isRetryableTtsFailure(at(401))).toBe(false)
    expect(isRetryableTtsFailure(at(403))).toBe(false)
    expect(isRetryableTtsFailure(at(404))).toBe(false)
    expect(isRetryableTtsFailure(at(503))).toBe(true)
    expect(isRetryableTtsFailure(at(502))).toBe(true)
    expect(isRetryableTtsFailure(at(429))).toBe(true)
  })

  it("retries a structured api-error with no status (unknown → transient)", () => {
    expect(isRetryableTtsFailure({ success: false, errorType: "api-error", error: "x" })).toBe(true)
  })

  it("always retries a structured network-error and never a permanent kind", () => {
    expect(isRetryableTtsFailure({ success: false, errorType: "network-error", error: "x" })).toBe(
      true
    )
    expect(
      isRetryableTtsFailure({ success: false, errorType: "api-key-missing", error: "x" })
    ).toBe(false)
    expect(isRetryableTtsFailure({ success: false, errorType: "text-too-long", error: "x" })).toBe(
      false
    )
  })
})

describe("withTtsRetry", () => {
  it("returns immediately on success without retrying", async () => {
    const fn = jest.fn(async () => ok)
    const res = await withTtsRetry(fn, { delay: noDelay })
    expect(res).toBe(ok)
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it("retries a transient failure then succeeds", async () => {
    const fn = jest
      .fn<Promise<TTSResponse>, []>()
      .mockResolvedValueOnce(networkFail)
      .mockResolvedValueOnce(ok)
    const res = await withTtsRetry(fn, { delay: noDelay })
    expect(res).toBe(ok)
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it("stops after `retries` exhausted and returns the last failure", async () => {
    const fn = jest.fn(async () => networkFail)
    const res = await withTtsRetry(fn, { retries: 2, delay: noDelay })
    expect(res).toBe(networkFail)
    expect(fn).toHaveBeenCalledTimes(3) // 1 initial + 2 retries
  })

  it("does not retry a permanent failure", async () => {
    const fn = jest.fn(async () => keyFail)
    const res = await withTtsRetry(fn, { delay: noDelay })
    expect(res).toBe(keyFail)
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it("waits the configured backoff before each retry", async () => {
    const delays: number[] = []
    const delay = (ms: number) => {
      delays.push(ms)
      return Promise.resolve()
    }
    const fn = jest.fn(async () => networkFail)
    await withTtsRetry(fn, { retries: 2, backoffMs: [100, 300], delay })
    expect(delays).toEqual([100, 300])
  })

  it("reuses the last backoff value when retries exceed the schedule", async () => {
    const delays: number[] = []
    const delay = (ms: number) => {
      delays.push(ms)
      return Promise.resolve()
    }
    const fn = jest.fn(async () => networkFail)
    await withTtsRetry(fn, { retries: 3, backoffMs: [50], delay })
    expect(delays).toEqual([50, 50, 50])
  })

  it("honors a custom isRetryable predicate", async () => {
    const fn = jest.fn(async () => keyFail)
    await withTtsRetry(fn, { retries: 1, delay: noDelay, isRetryable: () => true })
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it("uses a real timer delay when none is injected", async () => {
    const fn = jest
      .fn<Promise<TTSResponse>, []>()
      .mockResolvedValueOnce(networkFail)
      .mockResolvedValueOnce(ok)
    // No `delay` → exercises the default setTimeout-based delay (1ms backoff).
    const res = await withTtsRetry(fn, { retries: 1, backoffMs: [1] })
    expect(res).toBe(ok)
    expect(fn).toHaveBeenCalledTimes(2)
  })
})

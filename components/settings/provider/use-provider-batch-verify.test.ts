/**
 * @jest-environment jsdom
 */

import { act, renderHook, waitFor } from "@testing-library/react"

import type { UseProviderSettingsResult } from "@/hooks/settings/use-provider-settings"

import { useProviderBatchVerify } from "./use-provider-batch-verify"

const eligibleBuiltIn = jest.fn<string[], unknown[]>(() => [])
const eligibleCustom = jest.fn<string[], unknown[]>(() => [])
const retryBuiltIn = jest.fn<string[], unknown[]>(() => [])
const retryCustom = jest.fn<string[], unknown[]>(() => [])

jest.mock("./provider-readiness", () => ({
  getVisibleEligibleBuiltInProviderIds: (...a: unknown[]) => eligibleBuiltIn(...a),
  getVisibleEligibleCustomProviderIds: (...a: unknown[]) => eligibleCustom(...a),
  getVisibleRetryFailedBuiltInProviderIds: (...a: unknown[]) => retryBuiltIn(...a),
  getVisibleRetryFailedCustomProviderIds: (...a: unknown[]) => retryCustom(...a),
}))

type TestProvider = UseProviderSettingsResult["testProvider"]

function makeSettings(over: Partial<UseProviderSettingsResult> = {}): UseProviderSettingsResult {
  return {
    filteredProviders: [],
    providerSettings: {},
    testResults: {},
    visibleCustomProviderIds: [],
    customProviders: {},
    customTestResults: {},
    testProvider: jest.fn(async () => ({ success: true })) as unknown as TestProvider,
    testCustomProvider: jest.fn(async () => ({ success: true })) as unknown as TestProvider,
    ...over,
  } as unknown as UseProviderSettingsResult
}

beforeEach(() => {
  eligibleBuiltIn.mockReset().mockReturnValue([])
  eligibleCustom.mockReset().mockReturnValue([])
  retryBuiltIn.mockReset().mockReturnValue([])
  retryCustom.mockReset().mockReturnValue([])
})

describe("useProviderBatchVerify", () => {
  it("counts built-in and custom candidates together", () => {
    eligibleBuiltIn.mockReturnValue(["openai", "anthropic"])
    eligibleCustom.mockReturnValue(["my-gateway"])
    retryBuiltIn.mockReturnValue(["google"])
    retryCustom.mockReturnValue([])

    const { result } = renderHook(() => useProviderBatchVerify(makeSettings()))

    expect(result.current.eligibleCount).toBe(3)
    expect(result.current.retryCount).toBe(1)
  })

  it("starts idle with no strip-worthy state", () => {
    const { result } = renderHook(() => useProviderBatchVerify(makeSettings()))
    expect(result.current.verification).toEqual({
      isRunning: false,
      cancelRequested: false,
      total: 0,
      completed: 0,
      success: 0,
      failed: 0,
      canceled: false,
    })
  })

  it("tests every eligible provider and tallies the outcomes", async () => {
    eligibleBuiltIn.mockReturnValue(["openai", "anthropic"])
    eligibleCustom.mockReturnValue(["my-gateway"])
    const testProvider = jest.fn(async (id: string) => ({ success: id !== "anthropic" }))
    const testCustomProvider = jest.fn(async () => ({ success: true }))
    const settings = makeSettings({
      testProvider: testProvider as unknown as TestProvider,
      testCustomProvider: testCustomProvider as unknown as TestProvider,
    })

    const { result } = renderHook(() => useProviderBatchVerify(settings))
    await act(async () => {
      await result.current.runVerifyEnabled()
    })

    expect(testProvider.mock.calls.map(([id]) => id)).toEqual(["openai", "anthropic"])
    expect(testCustomProvider).toHaveBeenCalledWith("my-gateway")
    expect(result.current.verification).toMatchObject({
      isRunning: false,
      total: 3,
      completed: 3,
      success: 2,
      failed: 1,
      canceled: false,
    })
    expect(result.current.operationType).toBe("verify-enabled")
  })

  // A null result is what the facade returns when a provider cannot be tested
  // at all. Counting it as a pass would report a verified provider that was
  // never reached.
  it("counts a null result as a failure", async () => {
    eligibleBuiltIn.mockReturnValue(["openai"])
    const settings = makeSettings({
      testProvider: jest.fn(async () => null) as unknown as TestProvider,
    })

    const { result } = renderHook(() => useProviderBatchVerify(settings))
    await act(async () => {
      await result.current.runVerifyEnabled()
    })

    expect(result.current.verification).toMatchObject({ success: 0, failed: 1 })
  })

  it("runs the retry set and labels the summary as a retry", async () => {
    eligibleBuiltIn.mockReturnValue(["openai", "anthropic"])
    retryBuiltIn.mockReturnValue(["google"])
    const testProvider = jest.fn(async () => ({ success: true }))
    const settings = makeSettings({ testProvider: testProvider as unknown as TestProvider })

    const { result } = renderHook(() => useProviderBatchVerify(settings))
    await act(async () => {
      await result.current.runRetryFailed()
    })

    // The retry run must not sweep in the eligible set.
    expect(testProvider.mock.calls.map(([id]) => id)).toEqual(["google"])
    expect(result.current.operationType).toBe("retry-failed")
  })

  it("does nothing when there is nothing to test", async () => {
    const testProvider = jest.fn(async () => ({ success: true }))
    const settings = makeSettings({ testProvider: testProvider as unknown as TestProvider })

    const { result } = renderHook(() => useProviderBatchVerify(settings))
    await act(async () => {
      await result.current.runVerifyEnabled()
    })

    expect(testProvider).not.toHaveBeenCalled()
    // total stays 0, so the caller's `total > 0` strip gate keeps the progress
    // bar out of the layout instead of flashing an empty one.
    expect(result.current.verification.total).toBe(0)
  })

  it("stops after the in-flight job when cancelled, and says it was cancelled", async () => {
    eligibleBuiltIn.mockReturnValue(["a", "b", "c"])
    let release: (() => void) | undefined
    const testProvider = jest.fn(
      (id: string) =>
        new Promise<{ success: boolean }>((resolve) => {
          if (id === "a") release = () => resolve({ success: true })
          else resolve({ success: true })
        })
    )
    const settings = makeSettings({ testProvider: testProvider as unknown as TestProvider })

    const { result } = renderHook(() => useProviderBatchVerify(settings))
    let running: Promise<void> | undefined
    act(() => {
      running = result.current.runVerifyEnabled()
    })
    await waitFor(() => expect(result.current.verification.isRunning).toBe(true))

    act(() => result.current.cancel())
    // The button disables itself the moment the request lands, before the
    // in-flight job has resolved.
    expect(result.current.verification.cancelRequested).toBe(true)

    await act(async () => {
      release?.()
      await running
    })

    expect(testProvider).toHaveBeenCalledTimes(1)
    expect(result.current.verification).toMatchObject({
      isRunning: false,
      canceled: true,
      completed: 1,
      total: 3,
    })
  })

  // The cancel flag is a ref for exactly this reason: the loop reads it
  // between awaits, where a state value would still be the one captured when
  // the run started.
  it("clears a previous cancellation when a new run starts", async () => {
    eligibleBuiltIn.mockReturnValue(["a"])
    const settings = makeSettings()

    const { result } = renderHook(() => useProviderBatchVerify(settings))
    act(() => result.current.cancel())
    await act(async () => {
      await result.current.runVerifyEnabled()
    })

    expect(result.current.verification).toMatchObject({
      completed: 1,
      canceled: false,
      cancelRequested: false,
    })
  })
})

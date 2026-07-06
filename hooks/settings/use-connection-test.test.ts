import { renderHook, act } from "@testing-library/react"

const testMock = jest.fn()
jest.mock("@/lib/ai/infrastructure/api-test", () => ({
  testCustomProviderConnectionByProtocol: (...args: unknown[]) => testMock(...args),
}))

import { useConnectionTest } from "./use-connection-test"

beforeEach(() => {
  testMock.mockReset()
})

describe("useConnectionTest", () => {
  it("starts idle with no result", () => {
    const { result } = renderHook(() => useConnectionTest())
    expect(result.current.testing).toBe(false)
    expect(result.current.result).toBeNull()
  })

  it("flips testing on during the call and stores the full ApiTestResult on success", async () => {
    testMock.mockResolvedValue({
      success: true,
      message: "Connected successfully.",
      latency_ms: 42,
    })
    const { result } = renderHook(() => useConnectionTest())

    let inflight!: Promise<unknown>
    act(() => {
      inflight = result.current.test("https://api.example.com/v1", "sk-x", "openai")
    })
    expect(result.current.testing).toBe(true)
    expect(result.current.result).toBeNull()

    await act(async () => {
      await inflight
    })
    expect(result.current.testing).toBe(false)
    expect(result.current.result).toEqual({
      success: true,
      message: "Connected successfully.",
      latency_ms: 42,
    })
    expect(testMock).toHaveBeenCalledWith("https://api.example.com/v1", "sk-x", "openai")
  })

  it("preserves the 'limited' outcome instead of collapsing it to success/error", async () => {
    testMock.mockResolvedValue({
      success: true,
      outcome: "limited",
      message: "Verified with caveats.",
    })
    const { result } = renderHook(() => useConnectionTest())
    await act(async () => {
      await result.current.test("https://api.example.com/v1", "sk-x", "anthropic")
    })
    expect(result.current.result?.outcome).toBe("limited")
  })

  it("stores a failed ApiTestResult without throwing", async () => {
    testMock.mockResolvedValue({ success: false, message: "API error: 401" })
    const { result } = renderHook(() => useConnectionTest())
    await act(async () => {
      const r = await result.current.test("https://api.example.com/v1", "bad-key", "openai")
      expect(r.success).toBe(false)
    })
    expect(result.current.result).toEqual({ success: false, message: "API error: 401" })
  })

  it("clears the result on reset", async () => {
    testMock.mockResolvedValue({ success: true, message: "ok" })
    const { result } = renderHook(() => useConnectionTest())
    await act(async () => {
      await result.current.test("https://api.example.com/v1", "sk-x", "openai")
    })
    expect(result.current.result).not.toBeNull()

    act(() => {
      result.current.reset()
    })
    expect(result.current.result).toBeNull()
  })

  it("clears any stale result at the start of a new test run", async () => {
    testMock
      .mockResolvedValueOnce({ success: false, message: "API error: 401" })
      .mockResolvedValueOnce({ success: true, message: "ok" })
    const { result } = renderHook(() => useConnectionTest())
    await act(async () => {
      await result.current.test("https://api.example.com/v1", "sk-x", "openai")
    })
    expect(result.current.result?.success).toBe(false)

    let inflight!: Promise<unknown>
    act(() => {
      inflight = result.current.test("https://api.example.com/v1", "sk-x", "openai")
    })
    // The stale failure must be cleared immediately, before the new call resolves.
    expect(result.current.result).toBeNull()
    await act(async () => {
      await inflight
    })
    expect(result.current.result?.success).toBe(true)
  })
})

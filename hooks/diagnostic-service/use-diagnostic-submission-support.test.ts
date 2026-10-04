/** @jest-environment jsdom */

import { renderHook, waitFor } from "@testing-library/react"

import { useDiagnosticSubmissionSupport } from "./use-diagnostic-submission-support"

describe("useDiagnosticSubmissionSupport", () => {
  it("knows the desktop path on the first render without probing", () => {
    const resolveRuntime = jest.fn(async () => "mobile" as const)
    const { result } = renderHook(() =>
      useDiagnosticSubmissionSupport({ isDesktop: () => true, resolveRuntime })
    )
    expect(result.current).toEqual({ runtime: "desktop", supported: true, checking: false })
    expect(resolveRuntime).not.toHaveBeenCalled()
  })

  it("reports checking until the mobile probe answers, then the mobile path", async () => {
    const resolveRuntime = jest.fn(async () => "mobile" as const)
    const { result } = renderHook(() =>
      useDiagnosticSubmissionSupport({ isDesktop: () => false, resolveRuntime })
    )
    expect(result.current).toEqual({ runtime: null, supported: false, checking: true })
    await waitFor(() =>
      expect(result.current).toEqual({ runtime: "mobile", supported: true, checking: false })
    )
  })

  it("settles as unsupported when no path exists or the probe throws", async () => {
    const none = renderHook(() =>
      useDiagnosticSubmissionSupport({ isDesktop: () => false, resolveRuntime: async () => null })
    )
    await waitFor(() => expect(none.result.current.checking).toBe(false))
    expect(none.result.current.supported).toBe(false)

    const throwing = renderHook(() =>
      useDiagnosticSubmissionSupport({
        isDesktop: () => false,
        resolveRuntime: async () => {
          throw new Error("bridge gone")
        },
      })
    )
    await waitFor(() => expect(throwing.result.current.checking).toBe(false))
    expect(throwing.result.current.runtime).toBeNull()
  })
})

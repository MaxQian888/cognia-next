/** @jest-environment jsdom */
const mockStatus = jest.fn()
jest.mock("@/lib/ai/code-mode/sandbox-status", () => ({
  codeSandboxStatus: () => mockStatus(),
}))
jest.mock("@/lib/native/utils", () => ({ canUseTauriInvoke: () => true }))

import { renderHook, waitFor } from "@testing-library/react"
import { useCodeSandboxPresentations } from "./use-code-sandbox-presentations"

beforeEach(() => mockStatus.mockReset())

describe("useCodeSandboxPresentations", () => {
  // The gap between mount and probe is the dangerous one: offering `code`
  // optimistically would let a user pick something the host cannot run.
  it("starts at the fail-closed answer before the probe resolves", () => {
    mockStatus.mockReturnValue(new Promise(() => {}))
    const { result } = renderHook(() => useCodeSandboxPresentations())
    expect(result.current).toEqual(["native"])
  })

  it("widens once confinement is confirmed", async () => {
    mockStatus.mockResolvedValue({ confined: true, backend: "linux-bwrap", detail: "ok" })
    const { result } = renderHook(() => useCodeSandboxPresentations())
    await waitFor(() => expect(result.current).toContain("code"))
    expect(result.current).toEqual(expect.arrayContaining(["native", "code", "both"]))
  })

  it("stays native-only when confinement is not enforced", async () => {
    mockStatus.mockResolvedValue({ confined: false, backend: "linux-bwrap", detail: "broken" })
    const { result } = renderHook(() => useCodeSandboxPresentations())
    await waitFor(() => expect(mockStatus).toHaveBeenCalled())
    expect(result.current).toEqual(["native"])
  })

  it("does not set state after unmount", async () => {
    let resolve: (value: unknown) => void = () => {}
    mockStatus.mockReturnValue(new Promise((r) => (resolve = r)))
    const { unmount } = renderHook(() => useCodeSandboxPresentations())
    unmount()
    resolve({ confined: true })
    // No act() warning and no throw is the assertion; reaching here is a pass.
    await Promise.resolve()
  })
})

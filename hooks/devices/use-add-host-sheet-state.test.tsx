import { act, renderHook } from "@testing-library/react"

import { useAddHostSheetState } from "./use-add-host-sheet-state"

let searchParams = new URLSearchParams()
jest.mock("next/navigation", () => ({
  useSearchParams: () => searchParams,
}))

beforeEach(() => {
  searchParams = new URLSearchParams()
})

describe("useAddHostSheetState", () => {
  it("starts closed without a hand-off", () => {
    const { result } = renderHook(() => useAddHostSheetState())
    expect(result.current.open).toBe(false)
    expect(result.current.seededBaseUrl).toBeUndefined()
  })

  it("opens from a /servers hand-off and seeds the address", () => {
    searchParams = new URLSearchParams("addHost=1&baseUrl=https%3A%2F%2Fbox%3A27890")
    const { result } = renderHook(() => useAddHostSheetState())
    expect(result.current.open).toBe(true)
    expect(result.current.seededBaseUrl).toBe("https://box:27890")
  })

  it("stays closed once dismissed, though the URL still says open", () => {
    searchParams = new URLSearchParams("addHost=1")
    const { result, rerender } = renderHook(() => useAddHostSheetState())
    act(() => result.current.setOpen(false))
    rerender()
    expect(result.current.open).toBe(false)
  })

  it("does not shut a sheet the user opened when the param is cleared", () => {
    searchParams = new URLSearchParams("addHost=1")
    const { result, rerender } = renderHook(() => useAddHostSheetState())
    act(() => result.current.setOpen(false))
    act(() => result.current.setOpen(true))
    searchParams = new URLSearchParams()
    rerender()
    expect(result.current.open).toBe(true)
  })

  it("opens again for a new hand-off", () => {
    const { result, rerender } = renderHook(() => useAddHostSheetState())
    searchParams = new URLSearchParams("addHost=2")
    rerender()
    expect(result.current.open).toBe(true)
  })
})

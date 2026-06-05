import { act, renderHook } from "@testing-library/react"
import { useDocumentHidden } from "./use-document-visible"

function setVisibility(state: DocumentVisibilityState) {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => state,
  })
  document.dispatchEvent(new Event("visibilitychange"))
}

afterEach(() => {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => "visible",
  })
})

describe("useDocumentHidden", () => {
  it("starts from the current visibility", () => {
    const { result } = renderHook(() => useDocumentHidden())
    expect(result.current).toBe(false)
  })

  it("tracks visibilitychange transitions", () => {
    const { result } = renderHook(() => useDocumentHidden())
    act(() => setVisibility("hidden"))
    expect(result.current).toBe(true)
    act(() => setVisibility("visible"))
    expect(result.current).toBe(false)
  })

  it("stops listening after unmount", () => {
    const { result, unmount } = renderHook(() => useDocumentHidden())
    unmount()
    expect(() => act(() => setVisibility("hidden"))).not.toThrow()
    expect(result.current).toBe(false)
  })
})

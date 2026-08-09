import { act, renderHook } from "@testing-library/react"

import { useFinePointer } from "./use-fine-pointer"

describe("useFinePointer", () => {
  it("tracks the combined fine-pointer and hover media query", () => {
    let matches = false
    let listener: (() => void) | undefined
    window.matchMedia = jest.fn(() => {
      const media = {
        matches,
        media: "(pointer: fine) and (hover: hover)",
        onchange: null,
        addEventListener: jest.fn(
          (_event: string, callback: EventListenerOrEventListenerObject) => {
            listener = () => {
              if (typeof callback === "function") callback(new Event("change"))
              else callback.handleEvent(new Event("change"))
            }
          }
        ),
        removeEventListener: jest.fn(),
        addListener: jest.fn(),
        removeListener: jest.fn(),
        dispatchEvent: jest.fn(),
      } as unknown as MediaQueryList
      return media
    }) as typeof window.matchMedia

    const { result } = renderHook(() => useFinePointer())
    expect(result.current).toBe(false)

    matches = true
    act(() => listener?.())
    expect(result.current).toBe(true)
  })
})

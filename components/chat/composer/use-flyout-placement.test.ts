/**
 * @jest-environment jsdom
 */
import { renderHook } from "@testing-library/react"

jest.mock("@/hooks/ui/use-mobile", () => ({ useIsMobile: jest.fn(() => false) }))

import { useIsMobile } from "@/hooks/ui/use-mobile"
import { resolveFlyoutPlacement, useFlyoutPlacement } from "./use-flyout-placement"

const useIsMobileMock = useIsMobile as jest.Mock

describe("resolveFlyoutPlacement", () => {
  it("flies out to the right of the row on a wide screen", () => {
    expect(resolveFlyoutPlacement(false)).toMatchObject({ side: "right", align: "start" })
  })

  it("stacks above the row on a narrow screen, where neither side has room", () => {
    expect(resolveFlyoutPlacement(true)).toMatchObject({ side: "top", align: "center" })
  })

  it("keeps the panel inside the viewport on both", () => {
    for (const narrow of [false, true]) {
      const placement = resolveFlyoutPlacement(narrow)
      expect(placement.collisionPadding).toBeGreaterThan(0)
      expect(placement.className).toContain("max-w-[calc(100vw-1rem)]")
    }
  })
})

describe("useFlyoutPlacement", () => {
  it("follows the mobile breakpoint", () => {
    useIsMobileMock.mockReturnValue(true)
    expect(renderHook(() => useFlyoutPlacement()).result.current.side).toBe("top")
    useIsMobileMock.mockReturnValue(false)
    expect(renderHook(() => useFlyoutPlacement()).result.current.side).toBe("right")
  })
})

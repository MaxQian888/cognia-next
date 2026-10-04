/**
 * @jest-environment jsdom
 */
import { act, renderHook } from "@testing-library/react"

// eslint-disable-next-line no-var -- jest.mock factories hoist above this body.
var searchParams = new URLSearchParams()
// eslint-disable-next-line no-var -- same hoisting rule.
var replace = jest.fn()
jest.mock("next/navigation", () => ({
  useRouter: () => ({ replace }),
  usePathname: () => "/devices",
  useSearchParams: () => searchParams,
}))

import { useDeviceSectionLink } from "./use-device-section-link"

beforeEach(() => {
  jest.clearAllMocks()
})

it("reads the section a link names", () => {
  searchParams = new URLSearchParams("device=ssh%3Assh-1&deviceSection=files")
  const { result } = renderHook(() => useDeviceSectionLink())
  expect(result.current.section).toBe("files")
  expect(result.current.deviceRef).toBe("ssh:ssh-1")
})

it("strips only its own parameter once consumed, keeping the selected device", () => {
  searchParams = new URLSearchParams("device=ssh%3Assh-1&deviceSection=files")
  const { result } = renderHook(() => useDeviceSectionLink())
  act(() => result.current.consume())
  expect(replace).toHaveBeenCalledWith("/devices?device=ssh%3Assh-1", { scroll: false })
})

it("does nothing when there is no section to consume", () => {
  searchParams = new URLSearchParams("device=local")
  const { result } = renderHook(() => useDeviceSectionLink())
  expect(result.current.section).toBeNull()
  act(() => result.current.consume())
  expect(replace).not.toHaveBeenCalled()
})

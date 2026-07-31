import { render, act } from "@testing-library/react"

import { MobileOnlyInitializers } from "./mobile-only-initializers"

jest.mock("next/dynamic", () => () => {
  const Stub = () => <span data-testid="mobile-child" />
  Stub.displayName = "MockMobileChild"
  return Stub
})

const isMobileMock = jest.fn()
jest.mock("@/lib/capacitor/_shared", () => ({
  isMobile: () => isMobileMock(),
}))

describe("MobileOnlyInitializers", () => {
  beforeEach(() => {
    isMobileMock.mockReset()
  })

  it("renders nothing on desktop/web (isMobile() === false)", async () => {
    isMobileMock.mockReturnValue(false)
    let container!: HTMLElement
    await act(async () => {
      container = render(<MobileOnlyInitializers />).container
    })
    expect(container.querySelectorAll('[data-testid="mobile-child"]')).toHaveLength(0)
  })

  it("renders the splash once mounted on Capacitor", async () => {
    isMobileMock.mockReturnValue(true)
    let container!: HTMLElement
    await act(async () => {
      container = render(<MobileOnlyInitializers />).container
    })
    expect(container.querySelectorAll('[data-testid="mobile-child"]')).toHaveLength(1)
  })
})

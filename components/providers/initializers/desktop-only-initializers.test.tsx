import { render, act } from "@testing-library/react"

import { DesktopOnlyInitializers } from "./desktop-only-initializers"

// Replace every `next/dynamic(...)` call with the same lightweight stub so we
// can assert how many gated children get rendered without pulling the real
// desktop subsystem graphs into the test.
jest.mock("next/dynamic", () => () => {
  const Stub = () => <span data-testid="desktop-child" />
  Stub.displayName = "MockDesktopChild"
  return Stub
})

const isTauriMock = jest.fn()
jest.mock("@/lib/native/utils", () => ({
  isTauri: () => isTauriMock(),
}))

describe("DesktopOnlyInitializers", () => {
  beforeEach(() => {
    isTauriMock.mockReset()
  })

  it("renders nothing on web (isTauri() === false)", async () => {
    isTauriMock.mockReturnValue(false)
    let container!: HTMLElement
    await act(async () => {
      container = render(<DesktopOnlyInitializers />).container
    })
    expect(container.querySelectorAll('[data-testid="desktop-child"]')).toHaveLength(0)
  })

  it("renders every desktop child once mounted on Tauri", async () => {
    isTauriMock.mockReturnValue(true)
    let container!: HTMLElement
    await act(async () => {
      container = render(<DesktopOnlyInitializers />).container
    })
    // Mirrors the count of gated children in the component — a guard against
    // silently dropping one when the list changes.
    expect(container.querySelectorAll('[data-testid="desktop-child"]')).toHaveLength(13)
  })
})

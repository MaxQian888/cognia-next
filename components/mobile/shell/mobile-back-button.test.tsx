/** @jest-environment jsdom */

const back = jest.fn()
const replace = jest.fn()
jest.mock("next/navigation", () => ({
  useRouter: () => ({ back, replace, push: jest.fn() }),
}))
jest.mock("next-intl", () => ({
  useTranslations: (namespace: string) => (key: string) => `${namespace}.${key}`,
}))

import { fireEvent, render, screen } from "@testing-library/react"

import { MobileBackButton, canPopWithinApp } from "./mobile-back-button"

// jsdom has no Navigation API; the DOM lib types `window.navigation` as
// always present, so the stub goes through defineProperty rather than a cast.
function setNavigation(value: { canGoBack: boolean } | undefined): void {
  Object.defineProperty(window, "navigation", { configurable: true, writable: true, value })
}

beforeEach(() => {
  back.mockReset()
  replace.mockReset()
  setNavigation(undefined)
})

describe("canPopWithinApp", () => {
  it("falls back to the history length where the Navigation API is missing", () => {
    const fake = { history: { length: 2 } } as unknown as Window
    expect(canPopWithinApp(fake)).toBe(true)
    const cold = { history: { length: 1 } } as unknown as Window
    expect(canPopWithinApp(cold)).toBe(false)
  })
  it("prefers the Navigation API when present", () => {
    const fake = { history: { length: 5 }, navigation: { canGoBack: false } } as unknown as Window
    expect(canPopWithinApp(fake)).toBe(false)
  })
})

describe("MobileBackButton", () => {
  it("pops history instead of pushing the hub again", () => {
    // Pushing the hub grew history to `hub, screen, hub`, so the hardware
    // back button returned the reader to the screen they had just left.
    window.history.pushState(null, "", "/memory")
    render(<MobileBackButton />)
    fireEvent.click(screen.getByTestId("mobile-back-button"))
    expect(back).toHaveBeenCalledTimes(1)
    expect(replace).not.toHaveBeenCalled()
  })

  it("replaces to the fallback when there is nothing to pop", () => {
    const lengthSpy = jest.spyOn(window.history, "length", "get").mockReturnValue(1)
    try {
      render(<MobileBackButton fallbackHref="/discover" />)
      fireEvent.click(screen.getByTestId("mobile-back-button"))
      expect(replace).toHaveBeenCalledWith("/discover")
      expect(back).not.toHaveBeenCalled()
    } finally {
      lengthSpy.mockRestore()
    }
  })

  it("defaults the fallback to the Me hub", () => {
    const lengthSpy = jest.spyOn(window.history, "length", "get").mockReturnValue(1)
    try {
      render(<MobileBackButton />)
      fireEvent.click(screen.getByTestId("mobile-back-button"))
      expect(replace).toHaveBeenCalledWith("/me")
    } finally {
      lengthSpy.mockRestore()
    }
  })

  it("does not step out of the app when the previous entry belongs to another origin", () => {
    // history.length counts the other site / about:blank entry; the
    // Navigation API's canGoBack does not.
    window.history.pushState(null, "", "/projects")
    setNavigation({ canGoBack: false })
    render(<MobileBackButton />)
    fireEvent.click(screen.getByTestId("mobile-back-button"))
    expect(back).not.toHaveBeenCalled()
    expect(replace).toHaveBeenCalledWith("/me")
  })

  it("pops when the Navigation API says an in-app entry is behind this one", () => {
    const lengthSpy = jest.spyOn(window.history, "length", "get").mockReturnValue(1)
    try {
      setNavigation({ canGoBack: true })
      render(<MobileBackButton />)
      fireEvent.click(screen.getByTestId("mobile-back-button"))
      expect(back).toHaveBeenCalledTimes(1)
    } finally {
      lengthSpy.mockRestore()
    }
  })

  it("forwards its layout class and test id", () => {
    render(<MobileBackButton className="ml-1" testId="custom-back" />)
    expect(screen.getByTestId("custom-back")).toHaveClass("ml-1")
  })

  it("is labelled for screen readers, with an override", () => {
    const { rerender } = render(<MobileBackButton />)
    expect(screen.getByRole("button", { name: "mobile.shell.back" })).toBeInTheDocument()
    rerender(<MobileBackButton label="Back to settings" />)
    expect(screen.getByRole("button", { name: "Back to settings" })).toBeInTheDocument()
  })
})

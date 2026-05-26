import { render, screen, act } from "@testing-library/react"

import { AppSplash } from "./app-splash"

// `usePlatform` drives the mobile gate; flip it per test. (Jest allows factory
// references to variables prefixed with `mock`.)
let mockPlatform: "mobile" | "web" | "tauri" = "mobile"
jest.mock("@/hooks/use-platform", () => ({
  usePlatform: () => mockPlatform,
}))

describe("AppSplash", () => {
  beforeEach(() => {
    mockPlatform = "mobile"
    jest.useFakeTimers()
  })

  afterEach(() => {
    act(() => {
      jest.runOnlyPendingTimers()
    })
    jest.useRealTimers()
  })

  it("renders the branded boot splash on the mobile shell", () => {
    render(<AppSplash />)

    const splash = screen.getByTestId("app-splash")
    expect(splash).toBeInTheDocument()
    expect(splash).toHaveAttribute("data-state", "visible")
    // Accessible status name is i18n-driven (resolved from the en bundle).
    expect(screen.getByRole("status", { name: "Starting cognia" })).toBe(splash)
    // Circular logo reuses the shared PWA icon asset.
    const logo = splash.querySelector(".app-splash__logo") as HTMLElement
    expect(logo).not.toBeNull()
    expect(logo.style.backgroundImage).toContain("/icons/icon-512.png")
    // Ring + glow are decorative only.
    for (const sel of [".app-splash__ring", ".app-splash__glow"]) {
      expect(splash.querySelector(sel)).toHaveAttribute("aria-hidden", "true")
    }
  })

  it("renders nothing off the mobile shell (web / Tauri / SSR)", () => {
    mockPlatform = "web"
    const { container } = render(<AppSplash />)
    expect(container).toBeEmptyDOMElement()
  })

  it("fades out and unmounts on its own timer, never gated on boot work", () => {
    render(<AppSplash />)
    expect(screen.getByTestId("app-splash")).toHaveAttribute("data-state", "visible")

    // HOLD_MS → enters the fading phase.
    act(() => {
      jest.advanceTimersByTime(1500)
    })
    const fading = screen.getByTestId("app-splash")
    expect(fading).toHaveAttribute("data-state", "leaving")
    expect(fading).toHaveClass("app-splash--leaving")

    // FADE_MS → the overlay tears itself down so it can't strand the user.
    act(() => {
      jest.advanceTimersByTime(450)
    })
    expect(screen.queryByTestId("app-splash")).not.toBeInTheDocument()
  })
})

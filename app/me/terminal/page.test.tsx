/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"

// The screen owns transport selection + xterm; stub it so the thin route
// wrapper is the unit under test.
jest.mock("@/components/mobile/mobile-terminal-screen", () => ({
  MobileTerminalScreen: () => <div data-testid="stub-terminal-screen" />,
}))

import MeTerminalPage from "./page"

describe("MeTerminalPage", () => {
  it("mounts the MobileTerminalScreen", () => {
    render(<MeTerminalPage />)
    expect(screen.getByTestId("stub-terminal-screen")).toBeInTheDocument()
  })

  it("renders exactly the screen (no extra shell chrome)", () => {
    const { container } = render(<MeTerminalPage />)
    expect(container.firstChild).toHaveAttribute("data-testid", "stub-terminal-screen")
  })
})

/**
 * @jest-environment jsdom
 */
import { render, screen, fireEvent } from "@testing-library/react"

let reduced = false
jest.mock("motion/react", () => ({
  useReducedMotion: () => reduced,
  useInView: () => true,
  motion: {},
}))

import { DesktopTerminal } from "./desktop-terminal"

const copy = {
  title: "Terminal",
  playLabel: "Play",
  pauseLabel: "Pause",
  restartLabel: "Restart",
  completeLabel: "Terminal sequence complete",
}

describe("DesktopTerminal", () => {
  beforeEach(() => {
    reduced = false
  })

  it("starts with pause and restart controls", () => {
    render(<DesktopTerminal copy={copy} />)
    expect(screen.getByRole("button", { name: "Pause" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Restart" })).toBeInTheDocument()
  })

  it("pauses and resumes the transcript", () => {
    render(<DesktopTerminal copy={copy} />)
    fireEvent.click(screen.getByRole("button", { name: "Pause" }))
    expect(screen.getByRole("button", { name: "Play" })).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Play" }))
    expect(screen.getByRole("button", { name: "Pause" })).toBeInTheDocument()
  })

  describe("reduced motion", () => {
    beforeEach(() => {
      reduced = true
    })

    it("renders static transcript with all test lines", () => {
      render(<DesktopTerminal copy={copy} />)
      expect(screen.getByText(/git push/)).toBeInTheDocument()
      expect(screen.getByText(/applies the discount before tax/)).toBeInTheDocument()
      expect(screen.getByText(/keeps USD totals at two decimals/)).toBeInTheDocument()
      expect(screen.getByText(/rounds JPY totals to whole yen/)).toBeInTheDocument()
    })

    it("does not render playback controls", () => {
      render(<DesktopTerminal copy={copy} />)
      expect(screen.queryByRole("button", { name: "Play" })).toBeNull()
      expect(screen.queryByRole("button", { name: "Pause" })).toBeNull()
      expect(screen.queryByRole("button", { name: "Restart" })).toBeNull()
      expect(screen.getByText("Terminal sequence complete")).toHaveAttribute("aria-live", "polite")
    })
  })
})

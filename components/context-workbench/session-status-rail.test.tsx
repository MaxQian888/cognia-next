/** @jest-environment jsdom */
import { render, screen } from "@testing-library/react"
import { SessionStatusRail } from "./session-status-rail"

jest.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))

it("gives each state its own tone so idle, working and waiting are not one grey", () => {
  const tones = ["idle", "streaming", "awaiting_approval", "error"] as const
  const seen = new Set<string>()
  for (const displayStatus of tones) {
    const { container, unmount } = render(<SessionStatusRail displayStatus={displayStatus} />)
    const rail = container.firstElementChild!
    expect(rail).toHaveTextContent(`statuses.${displayStatus}`)
    // The class list is the tone: two states sharing one would put the card
    // back where it started.
    expect(seen.has(rail.className)).toBe(false)
    seen.add(rail.className)
    unmount()
  }
  expect(seen.size).toBe(4)
})

it("keeps the label off the role colour, which is unreadable at --warning's lightness", () => {
  render(<SessionStatusRail displayStatus="awaiting_approval" />)
  const label = screen.getByText("statuses.awaiting_approval")
  expect(label.className).not.toContain("text-warning")
  // The hue is carried by the icon instead, and the icon is decorative because
  // the label already names the state.
  const icon = screen.getByRole("status").querySelector("svg")
  expect(icon).toHaveAttribute("aria-hidden", "true")
  expect(icon?.getAttribute("class")).toContain("text-warning")
})

it("reads out a live error through alert and falls back to a catalogue line", () => {
  const { rerender } = render(<SessionStatusRail displayStatus="error" error="Disconnected" />)
  expect(screen.getByRole("alert")).toHaveTextContent("Disconnected")
  expect(screen.queryByRole("status")).not.toBeInTheDocument()
  rerender(<SessionStatusRail displayStatus="error" error={null} />)
  expect(screen.getByRole("alert")).toHaveTextContent("statusHints.error")
})

it("leaves idle without a second line rather than inventing reassurance", () => {
  render(<SessionStatusRail displayStatus="idle" />)
  expect(screen.getByRole("status").querySelectorAll("p")).toHaveLength(1)
  expect(screen.queryByText("statusHints.idle")).not.toBeInTheDocument()
})

it("spins only while a turn is actually running", () => {
  const { rerender } = render(<SessionStatusRail displayStatus="streaming" />)
  expect(screen.getByRole("status").querySelector("svg")?.getAttribute("class")).toContain(
    "animate-spin"
  )
  rerender(<SessionStatusRail displayStatus="idle" />)
  expect(screen.getByRole("status").querySelector("svg")?.getAttribute("class")).not.toContain(
    "animate-spin"
  )
})

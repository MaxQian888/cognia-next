/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"

import { CountPill } from "./count-pill"

test("renders nothing for zero", () => {
  const { container } = render(<CountPill count={0} />)
  expect(container).toBeEmptyDOMElement()
})

test("caps the number at 99+", () => {
  render(<CountPill count={140} testId="pill" />)
  expect(screen.getByTestId("pill")).toHaveTextContent("99+")
})

test("names the count for a screen reader when it is the only carrier", () => {
  render(<CountPill count={3} srLabel="3 unread" testId="pill" />)
  const pill = screen.getByTestId("pill")
  expect(pill).not.toHaveAttribute("aria-hidden")
  expect(screen.getByText("3 unread")).toHaveClass("sr-only")
  expect(screen.getByText("3")).toHaveAttribute("aria-hidden", "true")
})

test("stays out of the accessibility tree when its control already says the count", () => {
  render(<CountPill count={3} srLabel="ignored" decorative testId="pill" />)
  expect(screen.getByTestId("pill")).toHaveAttribute("aria-hidden", "true")
  expect(screen.queryByText("ignored")).toBeNull()
})

test("offers a soft tone and a corner placement", () => {
  render(<CountPill count={2} tone="soft" placement="corner" testId="pill" />)
  const pill = screen.getByTestId("pill")
  expect(pill).toHaveClass("bg-primary/15", "absolute")
  expect(pill).not.toHaveClass("bg-primary")
})

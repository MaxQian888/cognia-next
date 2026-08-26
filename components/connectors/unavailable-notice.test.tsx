/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react"

import { UnavailableNotice } from "./unavailable-notice"

it("joins the reason and the next step into one readable line", () => {
  render(<UnavailableNotice reason="Because." nextStep="Do this." cause="x" data-testid="n" />)
  expect(screen.getByTestId("n")).toHaveTextContent("Because. Do this.")
})

// Some causes are terminal. Padding them out to look actionable is the failure
// mode this component exists to make impossible.
it("ends after the reason when there is nothing to do", () => {
  render(<UnavailableNotice reason="Because." nextStep={null} cause="x" data-testid="n" />)
  expect(screen.getByTestId("n")).toHaveTextContent("Because.")
})

it("exposes the machine-readable cause", () => {
  render(<UnavailableNotice reason="r" cause="not_declared" data-testid="n" />)
  expect(screen.getByTestId("n")).toHaveAttribute("data-cause", "not_declared")
})

it("is announced as a note rather than an alert", () => {
  render(<UnavailableNotice reason="r" cause="x" data-testid="n" />)
  expect(screen.getByTestId("n")).toHaveAttribute("role", "note")
})

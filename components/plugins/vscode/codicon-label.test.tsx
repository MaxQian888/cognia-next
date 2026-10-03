/**
 * @jest-environment jsdom
 */

import { render } from "@testing-library/react"

import { CodiconIcon, CodiconLabel } from "./codicon-label"

it("draws known codicons, spins on request, and drops unknown ones", () => {
  const { container } = render(<CodiconLabel label="$(sync~spin) Sync $(made-up) done" />)
  const icon = container.querySelector('[data-codicon="sync"]')
  expect(icon).not.toBeNull()
  expect(icon?.getAttribute("class")).toContain("animate-spin")
  expect(container.querySelector('[data-codicon="made-up"]')).toBeNull()
  expect(container.textContent).toBe(" Sync  done")
})

it("always spins the loading icon", () => {
  const { container } = render(<CodiconIcon name="loading" />)
  expect(container.firstElementChild?.getAttribute("class")).toContain("animate-spin")
})

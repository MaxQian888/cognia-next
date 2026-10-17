/** @jest-environment jsdom */
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { UserMessageBody } from "./user-message-body"

let mockBodyHeight = 120
jest.mock("@/hooks/use-element-height", () => ({
  useElementHeight: (element: HTMLElement | null) => (element ? mockBodyHeight : 0),
}))
jest.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))

beforeEach(() => {
  mockBodyHeight = 120
})

it("leaves a short message fully available without a disclosure", () => {
  render(<UserMessageBody previewText="Short message">Short message</UserMessageBody>)
  expect(screen.queryByRole("button")).toBeNull()
  expect(screen.getByText("Short message")).not.toHaveAttribute("aria-hidden", "true")
})

it.each([
  [240, false],
  [241, true],
])("shows a disclosure at height %s only when the preview overflows", (height, overflows) => {
  mockBodyHeight = height as number
  render(<UserMessageBody previewText="Message">Message</UserMessageBody>)
  expect(screen.queryByRole("button") !== null).toBe(overflows)
})

it("shows a compact preview and expands or collapses the complete content", async () => {
  mockBodyHeight = 800
  const user = userEvent.setup()
  render(
    <UserMessageBody previewText="Preview text">
      <div>Complete message including its final paragraph</div>
      <button type="button">Image action</button>
    </UserMessageBody>
  )
  const toggle = screen.getByRole("button", { name: "expandUserMessage" })
  const body = document.getElementById(toggle.getAttribute("aria-controls")!)!
  expect(toggle).toHaveAttribute("aria-expanded", "false")
  expect(body).toHaveStyle({ maxHeight: "240px", overflow: "hidden" })
  expect(body.firstElementChild).toHaveAttribute("inert")
  expect(body.firstElementChild).toHaveAttribute("aria-hidden", "true")
  expect(screen.getByText("Preview text")).toHaveClass("sr-only")

  await user.click(toggle)
  expect(toggle).toHaveAccessibleName("collapseUserMessage")
  expect(toggle).toHaveAttribute("aria-expanded", "true")
  expect(body.style.maxHeight).toBe("")
  expect(body.firstElementChild).not.toHaveAttribute("inert")
  expect(body.firstElementChild).not.toHaveAttribute("aria-hidden", "true")
  expect(screen.getByText("Complete message including its final paragraph")).toBeInTheDocument()
  expect(screen.queryByText("Preview text")).toBeNull()

  await user.click(toggle)
  expect(toggle).toHaveAttribute("aria-expanded", "false")
  expect(body).toHaveStyle({ maxHeight: "240px" })
})

it("adapts when wrapping or loaded media makes a message taller", () => {
  const { rerender } = render(<UserMessageBody previewText="Message">Message</UserMessageBody>)
  expect(screen.queryByRole("button")).toBeNull()
  mockBodyHeight = 500
  rerender(<UserMessageBody previewText="Message">Message</UserMessageBody>)
  expect(screen.getByRole("button")).toHaveAttribute("aria-expanded", "false")
  mockBodyHeight = 100
  rerender(<UserMessageBody previewText="Message">Message</UserMessageBody>)
  expect(screen.queryByRole("button")).toBeNull()
})

it("keeps the user's expanded choice when its content reflows", async () => {
  mockBodyHeight = 500
  const user = userEvent.setup()
  const { rerender } = render(<UserMessageBody previewText="Message">Message</UserMessageBody>)
  await user.click(screen.getByRole("button"))
  mockBodyHeight = 900
  rerender(<UserMessageBody previewText="Message">Message</UserMessageBody>)
  expect(screen.getByRole("button")).toHaveAttribute("aria-expanded", "true")
})

it("starts a different message collapsed", async () => {
  mockBodyHeight = 500
  const user = userEvent.setup()
  const { rerender } = render(
    <UserMessageBody key="first" previewText="First">
      First
    </UserMessageBody>
  )
  await user.click(screen.getByRole("button"))
  rerender(
    <UserMessageBody key="second" previewText="Second">
      Second
    </UserMessageBody>
  )
  expect(screen.getByRole("button")).toHaveAttribute("aria-expanded", "false")
})

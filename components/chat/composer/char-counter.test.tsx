/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react"

const mockController: { value: string } = { value: "" }
jest.mock("@/components/ai-elements/prompt-input", () => ({
  usePromptInputController: () => ({ textInput: { value: mockController.value } }),
}))

import { CharCounter } from "./char-counter"

beforeEach(() => {
  mockController.value = ""
})

describe("CharCounter", () => {
  it("renders nothing for an empty input", () => {
    const { container } = render(<CharCounter />)
    expect(container.firstChild).toBeNull()
  })

  it("shows the count muted and does NOT announce it below the amber threshold", () => {
    mockController.value = "hello world"
    render(<CharCounter />)
    const el = screen.getByText("11")
    // No per-keystroke announcements while well under the limit.
    expect(el).toHaveAttribute("aria-live", "off")
    expect(el.className).not.toContain("text-amber-500")
    expect(el.className).not.toContain("text-destructive")
  })

  it("turns amber and starts announcing at 8 000 characters", () => {
    mockController.value = "a".repeat(8_000)
    render(<CharCounter />)
    const el = screen.getByText("8,000")
    expect(el).toHaveAttribute("aria-live", "polite")
    expect(el.className).toContain("text-amber-500")
  })

  it("turns destructive past 10 000 characters", () => {
    mockController.value = "a".repeat(10_500)
    render(<CharCounter />)
    const el = screen.getByText("10,500")
    expect(el).toHaveAttribute("aria-live", "polite")
    expect(el.className).toContain("text-destructive")
  })

  it("positions itself with the logical `end-2` so it stays trailing under RTL", () => {
    mockController.value = "x"
    render(<CharCounter />)
    expect(screen.getByText("1").className).toContain("end-2")
  })
})

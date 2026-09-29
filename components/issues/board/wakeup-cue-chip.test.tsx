/**
 * @jest-environment jsdom
 */

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, string | number>) =>
    vars ? `${key}:${Object.values(vars).join(",")}` : key,
}))

import { render, screen } from "@testing-library/react"
import { WakeupCueChip } from "./wakeup-cue-chip"

describe("WakeupCueChip", () => {
  it("counts waiting rules", () => {
    render(<WakeupCueChip cue={{ active: 2, paused: 0, held: 0 }} />)
    const chip = screen.getByTestId("issue-card-wakeup-cue")
    expect(chip).toHaveTextContent("2")
    expect(chip).toHaveAttribute("data-state", "active")
    expect(chip).toHaveAttribute("aria-label", "active:2")
  })

  it("lets a paused rule win the cue, names the reason, and mentions held inputs", () => {
    render(<WakeupCueChip cue={{ active: 1, paused: 1, pauseReason: "loop", held: 3 }} />)
    const chip = screen.getByTestId("issue-card-wakeup-cue")
    expect(chip).toHaveAttribute("data-state", "paused")
    expect(chip).toHaveTextContent("1")
    expect(chip).toHaveAttribute("aria-label", "pausedWith:1,reason.loop · active:1 · held:3")
  })

  it("says a rule is paused even without a known reason", () => {
    render(<WakeupCueChip cue={{ active: 0, paused: 2, held: 0 }} />)
    expect(screen.getByTestId("issue-card-wakeup-cue")).toHaveAttribute("aria-label", "paused:2")
  })

  it("renders nothing when no rule is waiting or paused", () => {
    const { container } = render(<WakeupCueChip cue={{ active: 0, paused: 0, held: 0 }} />)
    expect(container).toBeEmptyDOMElement()
  })
})

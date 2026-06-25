/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { SkillsBadge } from "./skills-badge"

// Identity i18n with var echo so we can assert the counter payload.
jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))

const SKILLS = [
  { id: "s1", name: "Skill One", description: "first" },
  { id: "s2", name: "Skill Two" },
]

describe("SkillsBadge", () => {
  it("renders the active/total counter (active = total - disabled)", () => {
    render(<SkillsBadge skills={SKILLS} disabled={new Set(["s1"])} onToggle={jest.fn()} />)
    // active = 2 - 1 = 1
    expect(screen.getByText(/counter:\{"active":1,"total":2\}/)).toBeInTheDocument()
  })

  it("opens the popover and toggles a skill off (nextDisabled = true)", async () => {
    const onToggle = jest.fn(async () => undefined)
    render(<SkillsBadge skills={SKILLS} disabled={new Set()} onToggle={onToggle} />)

    fireEvent.click(screen.getByLabelText("aria"))

    const switchEl = await screen.findByLabelText(`toggleAria:{"name":"Skill One"}`)
    // Enabled skill (checked) → toggling fires onToggle(id, true).
    fireEvent.click(switchEl)
    await waitFor(() => expect(onToggle).toHaveBeenCalledWith("s1", true))
  })

  it("toggles a disabled skill back on (nextDisabled = false)", async () => {
    const onToggle = jest.fn(async () => undefined)
    render(<SkillsBadge skills={SKILLS} disabled={new Set(["s2"])} onToggle={onToggle} />)

    fireEvent.click(screen.getByLabelText("aria"))
    const switchEl = await screen.findByLabelText(`toggleAria:{"name":"Skill Two"}`)
    fireEvent.click(switchEl)
    await waitFor(() => expect(onToggle).toHaveBeenCalledWith("s2", false))
  })
})

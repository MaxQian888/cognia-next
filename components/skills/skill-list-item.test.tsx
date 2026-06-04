/**
 * @jest-environment jsdom
 */

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))

const tauriRef = { current: false }
jest.mock("@/lib/tauri", () => ({
  isTauri: () => tauriRef.current,
}))

import { fireEvent, render, screen } from "@testing-library/react"
import { SkillListItem } from "./skill-list-item"
import type { Skill } from "@/lib/claude/types"

const baseSkill: Skill = {
  id: "s1",
  name: "Cite sources",
  description: "Cite all sources inline.",
  content: "Use [n] style citations.",
  source: "custom",
  status: "enabled",
  createdAt: 0,
  updatedAt: 0,
} as Skill

const handlers = {
  onToggleSelect: jest.fn(),
  onOpen: jest.fn(),
}

beforeEach(() => {
  tauriRef.current = false
  for (const fn of Object.values(handlers)) fn.mockReset()
})

describe("SkillListItem", () => {
  it("renders name and description", () => {
    render(<SkillListItem skill={baseSkill} selected={false} active={false} {...handlers} />)
    expect(screen.getByText("Cite sources")).toBeInTheDocument()
    expect(screen.getByText("Cite all sources inline.")).toBeInTheDocument()
  })

  it("invokes onOpen when the row is clicked", () => {
    render(<SkillListItem skill={baseSkill} selected={false} active={false} {...handlers} />)
    fireEvent.click(screen.getByText("Cite sources"))
    expect(handlers.onOpen).toHaveBeenCalledWith("s1")
  })

  it("invokes onToggleSelect (not onOpen) when the checkbox is clicked", () => {
    render(<SkillListItem skill={baseSkill} selected={false} active={false} {...handlers} />)
    fireEvent.click(screen.getByLabelText('card.selectAria:{"name":"Cite sources"}'))
    expect(handlers.onToggleSelect).toHaveBeenCalledWith("s1")
    expect(handlers.onOpen).not.toHaveBeenCalled()
  })

  it("reflects batch selection state on the checkbox", () => {
    render(<SkillListItem skill={baseSkill} selected={true} active={false} {...handlers} />)
    expect(screen.getByLabelText('card.selectAria:{"name":"Cite sources"}')).toHaveAttribute(
      "data-state",
      "checked"
    )
  })

  it("applies the active highlight to the row button", () => {
    render(<SkillListItem skill={baseSkill} selected={false} active={true} {...handlers} />)
    const row = screen.getByText("Cite sources").closest("button")
    expect(row).toHaveClass("border-l-primary")
  })

  it("shows a disabled badge for disabled skills", () => {
    render(
      <SkillListItem
        skill={{ ...baseSkill, status: "disabled" } as Skill}
        selected={false}
        active={false}
        {...handlers}
      />
    )
    expect(screen.getByText("status.disabled")).toBeInTheDocument()
  })

  it("shows the sync dot only in Tauri, colored by sync state", () => {
    tauriRef.current = true
    const { rerender } = render(
      <SkillListItem skill={baseSkill} selected={false} active={false} {...handlers} />
    )
    expect(screen.getByTestId("skill-sync-dot")).toHaveClass("bg-muted")
    rerender(
      <SkillListItem
        skill={{ ...baseSkill, syncFingerprint: "fp" } as Skill}
        selected={false}
        active={false}
        {...handlers}
      />
    )
    expect(screen.getByTestId("skill-sync-dot")).toHaveClass("bg-emerald-500")
    rerender(
      <SkillListItem
        skill={{ ...baseSkill, lastSyncError: "boom" } as Skill}
        selected={false}
        active={false}
        {...handlers}
      />
    )
    expect(screen.getByTestId("skill-sync-dot")).toHaveClass("bg-destructive")
  })

  it("shows a validation badge when the skill has validation errors", () => {
    render(
      <SkillListItem
        skill={
          {
            ...baseSkill,
            validationErrors: [{ message: "bad frontmatter" }],
          } as Skill
        }
        selected={false}
        active={false}
        {...handlers}
      />
    )
    expect(screen.getByLabelText('validation.cardBadge:{"count":1}')).toBeInTheDocument()
  })
})

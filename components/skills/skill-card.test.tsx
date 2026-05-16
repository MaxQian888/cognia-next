/**
 * @jest-environment jsdom
 */

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))

jest.mock("@/lib/tauri", () => ({
  isTauri: () => false,
}))

import { fireEvent, render, screen } from "@testing-library/react"
import { SkillCard } from "./skill-card"
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
  onEdit: jest.fn(),
  onDuplicate: jest.fn(),
  onExport: jest.fn(),
  onDelete: jest.fn(),
  onToggleStatus: jest.fn(),
}

beforeEach(() => {
  for (const fn of Object.values(handlers)) fn.mockReset()
})

describe("SkillCard", () => {
  it("localizes the select checkbox aria-label with the skill name", () => {
    render(<SkillCard skill={baseSkill} selected={false} {...handlers} />)
    expect(screen.getByLabelText('card.selectAria:{"name":"Cite sources"}')).toBeInTheDocument()
  })

  it("localizes the actions trigger aria-label with the skill name", () => {
    render(<SkillCard skill={baseSkill} selected={false} {...handlers} />)
    expect(screen.getByLabelText('card.actionsAria:{"name":"Cite sources"}')).toBeInTheDocument()
  })

  it("invokes onToggleSelect when the checkbox is clicked", () => {
    render(<SkillCard skill={baseSkill} selected={false} {...handlers} />)
    fireEvent.click(screen.getByLabelText('card.selectAria:{"name":"Cite sources"}'))
    expect(handlers.onToggleSelect).toHaveBeenCalledWith("s1")
  })

  it("invokes onOpen when the title button is clicked", () => {
    render(<SkillCard skill={baseSkill} selected={false} {...handlers} />)
    fireEvent.click(screen.getByText("Cite sources"))
    expect(handlers.onOpen).toHaveBeenCalledWith("s1")
  })
})

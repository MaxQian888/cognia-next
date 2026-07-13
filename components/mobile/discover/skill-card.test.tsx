/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { SkillCard } from "./skill-card"
import type { Skill } from "@cognia/agent-config-types"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

jest.mock("@/lib/db/skills", () => ({
  setSkillStatus: jest.fn().mockResolvedValue(undefined),
}))

// The full skill sheet pulls in editor machinery; stub it to observe its open state.
jest.mock("@/components/mobile/skills/mobile-skill-sheet", () => ({
  MobileSkillSheet: ({ open, skill }: { open: boolean; skill: Skill }) =>
    open ? <div data-testid="skill-sheet-open">{skill.name}</div> : null,
}))

import { setSkillStatus } from "@/lib/db/skills"

const setSkillStatusMock = setSkillStatus as jest.Mock

const mkSkill = (p: Partial<Skill> = {}): Skill =>
  ({
    id: "s1",
    name: "Summarize",
    description: "condense text",
    status: "enabled",
    createdAt: 0,
    updatedAt: 0,
    ...p,
  }) as unknown as Skill

describe("SkillCard", () => {
  beforeEach(() => setSkillStatusMock.mockClear())

  it("renders the name, description and enabled state", () => {
    render(<SkillCard skill={mkSkill()} />)
    expect(screen.getByText("Summarize")).toBeInTheDocument()
    expect(screen.getByText("condense text")).toBeInTheDocument()
    expect(screen.getByTestId("skill-card-s1")).toHaveAttribute("data-enabled", "true")
  })

  it("marks disabled skills via data-enabled", () => {
    render(<SkillCard skill={mkSkill({ status: "disabled" })} />)
    expect(screen.getByTestId("skill-card-s1")).toHaveAttribute("data-enabled", "false")
  })

  it("shows the built-in badge only for built-in skills", () => {
    render(<SkillCard skill={mkSkill({ isBuiltIn: true })} />)
    expect(screen.getByText("builtInBadge")).toBeInTheDocument()
  })

  it("opens the skill sheet when the card body is clicked", async () => {
    const user = userEvent.setup()
    render(<SkillCard skill={mkSkill()} />)
    expect(screen.queryByTestId("skill-sheet-open")).not.toBeInTheDocument()
    await user.click(screen.getByTestId("skill-card-s1"))
    expect(screen.getByTestId("skill-sheet-open")).toBeInTheDocument()
  })

  it("routes the switch to onToggle when provided (not setSkillStatus)", async () => {
    const onToggle = jest.fn()
    const user = userEvent.setup()
    const skill = mkSkill()
    render(<SkillCard skill={skill} onToggle={onToggle} />)
    await user.click(screen.getByRole("switch"))
    expect(onToggle).toHaveBeenCalledWith(skill)
    expect(setSkillStatusMock).not.toHaveBeenCalled()
  })

  it("falls back to setSkillStatus when no onToggle is supplied", async () => {
    const user = userEvent.setup()
    render(<SkillCard skill={mkSkill({ status: "enabled" })} />)
    await user.click(screen.getByRole("switch"))
    expect(setSkillStatusMock).toHaveBeenCalledWith("s1", "disabled")
  })
})

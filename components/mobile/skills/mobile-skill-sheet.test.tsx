/**
 * @jest-environment jsdom
 */

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

const updateSkillMock = jest.fn()
jest.mock("@/lib/db/skills", () => ({
  updateSkill: (...a: unknown[]) => updateSkillMock(...a),
}))

const toastSuccess = jest.fn()
const toastError = jest.fn()
jest.mock("sonner", () => ({
  toast: {
    success: (...a: unknown[]) => toastSuccess(...a),
    error: (...a: unknown[]) => toastError(...a),
  },
}))

jest.mock("@/components/skills/skill-resource-manager", () => ({
  SkillResourceManager: () => <div data-testid="resource-manager-stub" />,
}))
jest.mock("@/components/skills/skill-validation-section", () => ({
  SkillValidationSection: ({ errors }: { errors: unknown[] }) => (
    <div data-testid="validation-stub">{errors.length}</div>
  ),
}))

import { fireEvent, render, screen } from "@testing-library/react"
import { MobileSkillSheet } from "./mobile-skill-sheet"
import type { Skill } from "@/lib/claude/types"

function makeSkill(over: Partial<Skill> = {}): Skill {
  return {
    id: "skill_1",
    name: "Test",
    content: "body",
    description: "Hi",
    createdAt: 0,
    updatedAt: Date.now(),
    source: "custom",
    ...over,
  } as Skill
}

beforeEach(() => {
  updateSkillMock.mockReset().mockResolvedValue(undefined)
  toastSuccess.mockReset()
  toastError.mockReset()
})

describe("MobileSkillSheet", () => {
  it("renders 4 tabs", () => {
    render(<MobileSkillSheet skill={makeSkill()} open onOpenChange={jest.fn()} />)
    expect(screen.getByRole("tab", { name: "tabOverview" })).toBeInTheDocument()
    expect(screen.getByRole("tab", { name: "tabEdit" })).toBeInTheDocument()
    expect(screen.getByRole("tab", { name: "tabResources" })).toBeInTheDocument()
    expect(screen.getByRole("tab", { name: "tabValidation" })).toBeInTheDocument()
  })

  it("renders the skill name in the header", () => {
    render(
      <MobileSkillSheet skill={makeSkill({ name: "My Skill" })} open onOpenChange={jest.fn()} />
    )
    expect(screen.getByText("My Skill")).toBeInTheDocument()
  })

  it("does not render when open is false", () => {
    const { container } = render(
      <MobileSkillSheet skill={makeSkill()} open={false} onOpenChange={jest.fn()} />
    )
    expect(container.querySelectorAll("[role='tab']").length).toBe(0)
  })
})

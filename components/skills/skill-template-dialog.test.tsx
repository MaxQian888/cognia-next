/**
 * @jest-environment jsdom
 */

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

import { fireEvent, render, screen } from "@testing-library/react"
import { SkillTemplateDialog } from "./skill-template-dialog"
import { useSkillsStore } from "@/stores/skills"
import { SKILL_TEMPLATES } from "@/lib/skills/templates"

beforeEach(() => {
  useSkillsStore.setState({ editorTarget: null, createSeed: null } as never)
})

describe("SkillTemplateDialog", () => {
  it("renders a card per template when open", () => {
    render(<SkillTemplateDialog open onOpenChange={jest.fn()} />)
    for (const tpl of SKILL_TEMPLATES) {
      expect(screen.getByTestId(`skill-template-${tpl.id}`)).toBeInTheDocument()
    }
  })

  it("seeds the create editor and closes when a template is picked", () => {
    const onOpenChange = jest.fn()
    render(<SkillTemplateDialog open onOpenChange={onOpenChange} />)
    fireEvent.click(screen.getByTestId("skill-template-code-review"))
    const state = useSkillsStore.getState()
    expect(state.editorTarget).toEqual({ mode: "create" })
    expect(state.createSeed?.content).toContain("Code review")
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })
})

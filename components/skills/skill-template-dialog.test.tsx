/**
 * @jest-environment jsdom
 */

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { SkillTemplateDialog } from "./skill-template-dialog"
import { useSkillsStore } from "@/stores/skills"
import { SKILL_TEMPLATES } from "@/lib/skills/templates"

beforeEach(() => {
  useSkillsStore.setState({ editorTarget: null, createSeed: null } as never)
})

describe("SkillTemplateDialog", () => {
  it("renders an accessible list of template actions when open", () => {
    render(<SkillTemplateDialog open onOpenChange={jest.fn()} />)
    for (const tpl of SKILL_TEMPLATES) {
      expect(screen.getByRole("button", { name: new RegExp(tpl.name) })).toBeInTheDocument()
    }
    expect(screen.getAllByRole("listitem")).toHaveLength(SKILL_TEMPLATES.length)
  })

  it("seeds the create editor and closes when a template is picked", async () => {
    const user = userEvent.setup()
    const onOpenChange = jest.fn()
    render(<SkillTemplateDialog open onOpenChange={onOpenChange} />)
    await user.click(screen.getByRole("button", { name: /Code review/ }))
    const state = useSkillsStore.getState()
    expect(state.editorTarget).toEqual({ mode: "create" })
    expect(state.createSeed?.content).toContain("Code review")
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })
})

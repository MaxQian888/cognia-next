/**
 * @jest-environment jsdom
 */

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))

import { fireEvent, render, screen } from "@testing-library/react"
import { SkillDeleteDialog } from "./skill-delete-dialog"

describe("SkillDeleteDialog", () => {
  it("renders the localized title and body with the skill name", () => {
    render(
      <SkillDeleteDialog open skillName="Cite sources" onCancel={jest.fn()} onConfirm={jest.fn()} />
    )
    expect(screen.getByText("title")).toBeInTheDocument()
    expect(screen.getByText('body:{"name":"Cite sources"}')).toBeInTheDocument()
  })

  it("fires onConfirm when the confirm action is clicked", () => {
    const onConfirm = jest.fn()
    render(<SkillDeleteDialog open skillName="X" onCancel={jest.fn()} onConfirm={onConfirm} />)
    fireEvent.click(screen.getByText("confirm"))
    expect(onConfirm).toHaveBeenCalled()
  })

  it("fires onCancel when the cancel action is clicked", () => {
    const onCancel = jest.fn()
    render(<SkillDeleteDialog open skillName="X" onCancel={onCancel} onConfirm={jest.fn()} />)
    fireEvent.click(screen.getByText("cancel"))
    expect(onCancel).toHaveBeenCalled()
  })
})

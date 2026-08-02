/**
 * @jest-environment jsdom
 */

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))

import { fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
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

describe("deleting the recordings behind a skill", () => {
  it("asks nothing extra when the skill was never recorded", () => {
    const onConfirm = jest.fn()
    render(<SkillDeleteDialog open skillName="X" onCancel={jest.fn()} onConfirm={onConfirm} />)
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument()
    fireEvent.click(screen.getByText("confirm"))
    expect(onConfirm).toHaveBeenCalledWith({ deleteRecordings: false })
  })

  it("offers the choice, off by default, when there is a capture behind it", () => {
    // Removing a skill does not imply discarding the recording it came from,
    // so the destructive half is opt-in.
    const onConfirm = jest.fn()
    render(
      <SkillDeleteDialog
        open
        skillName="X"
        recordingCount={2}
        onCancel={jest.fn()}
        onConfirm={onConfirm}
      />
    )
    expect(screen.getByRole("checkbox")).not.toBeChecked()
    expect(screen.getByText('bundles.label:{"count":2}')).toBeInTheDocument()
    expect(screen.getByText("bundles.hint")).toBeInTheDocument()

    fireEvent.click(screen.getByText("confirm"))
    expect(onConfirm).toHaveBeenCalledWith({ deleteRecordings: false })
  })

  it("passes the opt-in through once the user ticks it", async () => {
    const user = userEvent.setup()
    const onConfirm = jest.fn()
    render(
      <SkillDeleteDialog
        open
        skillName="X"
        recordingCount={1}
        onCancel={jest.fn()}
        onConfirm={onConfirm}
      />
    )
    await user.click(screen.getByRole("checkbox"))
    await user.click(screen.getByText("confirm"))
    expect(onConfirm).toHaveBeenCalledWith({ deleteRecordings: true })
  })

  it("never carries a tick from one skill to the next", async () => {
    // A checkbox someone ticked for one skill must not silently destroy the
    // next skill's recordings.
    const user = userEvent.setup()
    const { rerender } = render(
      <SkillDeleteDialog
        open
        skillName="X"
        recordingCount={1}
        onCancel={jest.fn()}
        onConfirm={jest.fn()}
      />
    )
    await user.click(screen.getByRole("checkbox"))
    expect(screen.getByRole("checkbox")).toBeChecked()

    rerender(
      <SkillDeleteDialog
        open={false}
        skillName="X"
        recordingCount={1}
        onCancel={jest.fn()}
        onConfirm={jest.fn()}
      />
    )
    rerender(
      <SkillDeleteDialog
        open
        skillName="Y"
        recordingCount={1}
        onCancel={jest.fn()}
        onConfirm={jest.fn()}
      />
    )
    expect(screen.getByRole("checkbox")).not.toBeChecked()
  })
})

/** @jest-environment jsdom */

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import {
  IssueAssignConfig,
  IssueCommentConfig,
  IssueCreateConfig,
  IssueEventTriggerConfig,
  IssueLabelConfig,
  IssueListConfig,
  IssueRefConfig,
  IssueUpdateConfig,
} from "./issue-forms"

function harness(
  Form: React.ComponentType<{
    params: Record<string, unknown>
    onChange: (p: Record<string, unknown>) => void
  }>,
  params: Record<string, unknown> = {}
) {
  const onChange = jest.fn()
  render(<Form params={params} onChange={onChange} />)
  return onChange
}

describe("issue forms", () => {
  it("exports every inspector form", () => {
    expect(
      [
        IssueCreateConfig,
        IssueRefConfig,
        IssueListConfig,
        IssueUpdateConfig,
        IssueAssignConfig,
        IssueCommentConfig,
        IssueLabelConfig,
        IssueEventTriggerConfig,
      ].every((form) => typeof form === "function")
    ).toBe(true)
  })

  it("writes label names as an array and clears them when the box empties", () => {
    const onChange = harness(IssueLabelConfig, { issue: "MERC-1" })
    fireEvent.change(screen.getByLabelText("add.label"), { target: { value: "bug, docs ,," } })
    expect(onChange).toHaveBeenLastCalledWith({ issue: "MERC-1", add: ["bug", "docs"] })
    fireEvent.change(screen.getByLabelText("remove.label"), { target: { value: "  " } })
    expect(onChange).toHaveBeenLastCalledWith({ issue: "MERC-1" })
  })

  it("keeps an empty number box as 'not given' rather than zero", () => {
    const onChange = harness(IssueCreateConfig, { title: "x", estimate: 3 })
    fireEvent.change(screen.getByLabelText("estimate.label"), { target: { value: "" } })
    expect(onChange).toHaveBeenLastCalledWith({ title: "x" })
    fireEvent.change(screen.getByLabelText("estimate.label"), { target: { value: "5" } })
    expect(onChange).toHaveBeenLastCalledWith({ title: "x", estimate: 5 })
  })

  it("only asks for an assignee id when the kind needs one", () => {
    harness(IssueAssignConfig, { assigneeKind: "human" })
    expect(screen.queryByLabelText("assigneeId.label")).not.toBeInTheDocument()
    harness(IssueAssignConfig, { assigneeKind: "team" })
    expect(screen.getByLabelText("assigneeId.label")).toBeInTheDocument()
  })

  it("toggles trigger kinds and drops the filter when none are left", () => {
    const onChange = harness(IssueEventTriggerConfig, { kinds: ["commented"] })
    fireEvent.click(screen.getByTestId("issue-event-created"))
    expect(onChange).toHaveBeenLastCalledWith({ kinds: ["commented", "created"] })
    fireEvent.click(screen.getByTestId("issue-event-commented"))
    expect(onChange).toHaveBeenLastCalledWith({})
  })

  it("toggles list statuses through the same rule", () => {
    const onChange = harness(IssueListConfig, { statuses: ["todo"] })
    fireEvent.click(screen.getByTestId("issue-list-status-todo"))
    expect(onChange).toHaveBeenLastCalledWith({})
  })

  it("writes a comment body and an update title verbatim", () => {
    const onChange = harness(IssueCommentConfig, { issue: "MERC-1" })
    fireEvent.change(screen.getByLabelText("body.label"), { target: { value: "hi" } })
    expect(onChange).toHaveBeenLastCalledWith({ issue: "MERC-1", body: "hi" })
    const onUpdate = harness(IssueUpdateConfig, {})
    fireEvent.change(screen.getByLabelText("title.label"), { target: { value: "New" } })
    expect(onUpdate).toHaveBeenLastCalledWith({ title: "New" })
  })

  it("writes only a legal sub-issue stage and files a new issue into triage", () => {
    const onChange = harness(IssueCreateConfig, { title: "x" })
    fireEvent.change(screen.getByLabelText("stage.label"), { target: { value: "2" } })
    expect(onChange).toHaveBeenLastCalledWith({ title: "x", stage: 2 })
    onChange.mockClear()
    // Zero, a fraction and past the ceiling are half-typed, not edits.
    for (const value of ["0", "1.5", "1001"]) {
      fireEvent.change(screen.getByLabelText("stage.label"), { target: { value } })
    }
    expect(onChange).toHaveBeenCalledTimes(3)
    for (const [params] of onChange.mock.calls) expect(params).toEqual({ title: "x" })
    fireEvent.click(screen.getByTestId("issue-create-triage"))
    expect(onChange).toHaveBeenLastCalledWith({ title: "x", triage: "pending" })
  })

  it("clears an update's stage with null and locks the box while it does", () => {
    const onChange = harness(IssueUpdateConfig, { issue: "MERC-1", stage: 3 })
    fireEvent.click(screen.getByTestId("issue-update-stage-clear"))
    expect(onChange).toHaveBeenLastCalledWith({ issue: "MERC-1", stage: null })
    cleanup()
    harness(IssueUpdateConfig, { issue: "MERC-1", stage: null })
    expect(screen.getByLabelText("stage.label")).toBeDisabled()
  })

  it("shows an update's triage choice as send or accept", () => {
    harness(IssueUpdateConfig, { issue: "MERC-1", triage: null })
    expect(screen.getByText("triageOptions.accept")).toBeInTheDocument()
    harness(IssueUpdateConfig, { issue: "MERC-2", triage: "pending" })
    expect(screen.getByText("triageOptions.pending")).toBeInTheDocument()
  })
})

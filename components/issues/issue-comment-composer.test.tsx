/** @jest-environment jsdom */

jest.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))

import userEvent from "@testing-library/user-event"
import { render, screen, waitFor } from "@testing-library/react"
import { IssueCommentComposer } from "./issue-comment-composer"

describe("IssueCommentComposer", () => {
  it("cannot send an empty comment", () => {
    render(<IssueCommentComposer onSubmit={jest.fn()} />)
    expect(screen.getByTestId("issue-comment-submit")).toBeDisabled()
  })

  it("cannot send whitespace either", async () => {
    const user = userEvent.setup()
    render(<IssueCommentComposer onSubmit={jest.fn()} />)
    await user.type(screen.getByTestId("issue-comment-input"), "   ")
    expect(screen.getByTestId("issue-comment-submit")).toBeDisabled()
  })

  it("sends the trimmed body", async () => {
    const user = userEvent.setup()
    const onSubmit = jest.fn()
    render(<IssueCommentComposer onSubmit={onSubmit} />)
    await user.type(screen.getByTestId("issue-comment-input"), "  looks good  ")
    await user.click(screen.getByTestId("issue-comment-submit"))
    expect(onSubmit).toHaveBeenCalledWith("looks good")
  })

  it("clears the box once the write lands", async () => {
    const user = userEvent.setup()
    render(<IssueCommentComposer onSubmit={jest.fn()} />)
    await user.type(screen.getByTestId("issue-comment-input"), "hi")
    await user.click(screen.getByTestId("issue-comment-submit"))
    await waitFor(() => expect(screen.getByTestId("issue-comment-input")).toHaveValue(""))
  })

  it("keeps the text when the write fails, rather than losing it", async () => {
    const user = userEvent.setup()
    const onSubmit = jest.fn().mockRejectedValue(new Error("boom"))
    render(<IssueCommentComposer onSubmit={onSubmit} />)
    await user.type(screen.getByTestId("issue-comment-input"), "hi")
    await user.click(screen.getByTestId("issue-comment-submit"))
    await waitFor(() => expect(screen.getByTestId("issue-comment-input")).toHaveValue("hi"))
  })

  it("sends on Ctrl+Enter", async () => {
    const user = userEvent.setup()
    const onSubmit = jest.fn()
    render(<IssueCommentComposer onSubmit={onSubmit} />)
    await user.type(screen.getByTestId("issue-comment-input"), "hi")
    await user.keyboard("{Control>}{Enter}{/Control}")
    expect(onSubmit).toHaveBeenCalledWith("hi")
  })

  it("keeps a bare Enter as a newline, because comments run long", async () => {
    const user = userEvent.setup()
    const onSubmit = jest.fn()
    render(<IssueCommentComposer onSubmit={onSubmit} />)
    await user.type(screen.getByTestId("issue-comment-input"), "one{Enter}two")
    expect(onSubmit).not.toHaveBeenCalled()
    expect(screen.getByTestId("issue-comment-input")).toHaveValue("one\ntwo")
  })

  it("is inert when disabled", () => {
    render(<IssueCommentComposer onSubmit={jest.fn()} disabled />)
    expect(screen.getByTestId("issue-comment-input")).toBeDisabled()
    expect(screen.getByTestId("issue-comment-submit")).toBeDisabled()
  })
})

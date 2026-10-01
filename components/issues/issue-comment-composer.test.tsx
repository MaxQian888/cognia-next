/** @jest-environment jsdom */

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}(${Object.values(values).join("|")})` : key,
  useFormatter: () => ({ list: (items: string[]) => items.join(" & ") }),
}))

import userEvent from "@testing-library/user-event"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { IssueCommentComposer } from "./issue-comment-composer"

const ADA = { userId: "usr_ada", displayName: "Ada Lovelace" }
const BOB = { userId: "usr_bob", displayName: "Bob" }
const BOB_TWO = { userId: "usr_bob2", displayName: "Bob" }

function input(): HTMLTextAreaElement {
  return screen.getByTestId("issue-comment-input") as HTMLTextAreaElement
}

describe("IssueCommentComposer", () => {
  it("cannot send an empty comment", () => {
    render(<IssueCommentComposer onSubmit={jest.fn()} />)
    expect(screen.getByTestId("issue-comment-submit")).toBeDisabled()
  })

  it("cannot send whitespace either", async () => {
    const user = userEvent.setup()
    render(<IssueCommentComposer onSubmit={jest.fn()} />)
    await user.type(input(), "   ")
    expect(screen.getByTestId("issue-comment-submit")).toBeDisabled()
  })

  it("sends the trimmed body with no mentions", async () => {
    const user = userEvent.setup()
    const onSubmit = jest.fn()
    render(<IssueCommentComposer onSubmit={onSubmit} />)
    await user.type(input(), "  looks good  ")
    await user.click(screen.getByTestId("issue-comment-submit"))
    expect(onSubmit).toHaveBeenCalledWith("looks good", [])
  })

  it("clears the box once the write lands", async () => {
    const user = userEvent.setup()
    render(<IssueCommentComposer onSubmit={jest.fn()} />)
    await user.type(input(), "hi")
    await user.click(screen.getByTestId("issue-comment-submit"))
    await waitFor(() => expect(input()).toHaveValue(""))
  })

  it("keeps the text when the write fails, rather than losing it", async () => {
    const user = userEvent.setup()
    const onSubmit = jest.fn().mockRejectedValue(new Error("boom"))
    render(<IssueCommentComposer onSubmit={onSubmit} />)
    await user.type(input(), "hi")
    await user.click(screen.getByTestId("issue-comment-submit"))
    await waitFor(() => expect(input()).toHaveValue("hi"))
  })

  it("sends on Ctrl+Enter", async () => {
    const user = userEvent.setup()
    const onSubmit = jest.fn()
    render(<IssueCommentComposer onSubmit={onSubmit} />)
    await user.type(input(), "hi")
    await user.keyboard("{Control>}{Enter}{/Control}")
    expect(onSubmit).toHaveBeenCalledWith("hi", [])
  })

  it("keeps a bare Enter as a newline, because comments run long", async () => {
    const user = userEvent.setup()
    const onSubmit = jest.fn()
    render(<IssueCommentComposer onSubmit={onSubmit} />)
    await user.type(input(), "one{Enter}two")
    expect(onSubmit).not.toHaveBeenCalled()
    expect(input()).toHaveValue("one\ntwo")
  })

  it("is inert when disabled", () => {
    render(<IssueCommentComposer onSubmit={jest.fn()} disabled mentionCandidates={[ADA]} />)
    expect(input()).toBeDisabled()
    expect(screen.getByTestId("issue-comment-submit")).toBeDisabled()
    expect(screen.getByRole("button", { name: "detail.mention.trigger" })).toBeDisabled()
  })

  describe("mentions", () => {
    it("offers no picker without candidates", async () => {
      const user = userEvent.setup()
      const { rerender } = render(<IssueCommentComposer onSubmit={jest.fn()} />)
      expect(screen.queryByRole("button", { name: "detail.mention.trigger" })).toBeNull()
      rerender(<IssueCommentComposer onSubmit={jest.fn()} mentionCandidates={[]} />)
      expect(screen.queryByRole("button", { name: "detail.mention.trigger" })).toBeNull()
      // Typing an @ opens nothing either.
      await user.type(input(), "@")
      expect(screen.queryByTestId("issue-comment-mention-picker")).toBeNull()
    })

    it("inserts the picked name at the caret and sends its declared id", async () => {
      const user = userEvent.setup()
      const onSubmit = jest.fn()
      render(<IssueCommentComposer onSubmit={onSubmit} mentionCandidates={[ADA, BOB]} />)

      await user.type(input(), "please review")
      // Caret between "please" and " review".
      input().setSelectionRange(6, 6)
      await user.click(screen.getByRole("button", { name: "detail.mention.trigger" }))
      expect(await screen.findByTestId("issue-comment-mention-picker")).toBeInTheDocument()
      await user.click(screen.getByRole("option", { name: "Ada Lovelace" }))

      expect(input()).toHaveValue("please @Ada Lovelace review")
      await waitFor(() => expect(input()).toHaveFocus())
      expect(input().selectionStart).toBe("please @Ada Lovelace ".length)
      expect(screen.getByTestId("issue-comment-mentions")).toHaveTextContent(
        "detail.mention.willNotify(Ada Lovelace)"
      )

      await user.click(screen.getByTestId("issue-comment-submit"))
      expect(onSubmit).toHaveBeenCalledWith("please @Ada Lovelace review", ["usr_ada"])
    })

    it("filters the list by name", async () => {
      const user = userEvent.setup()
      render(<IssueCommentComposer onSubmit={jest.fn()} mentionCandidates={[ADA, BOB]} />)
      await user.click(screen.getByRole("button", { name: "detail.mention.trigger" }))
      await user.type(screen.getByPlaceholderText("detail.mention.search"), "bo")
      expect(screen.getByRole("option", { name: "Bob" })).toBeInTheDocument()
      expect(screen.queryByRole("option", { name: "Ada Lovelace" })).toBeNull()
    })

    it("opens the picker when an @ starts a word, and replaces that @", async () => {
      const user = userEvent.setup()
      const onSubmit = jest.fn()
      render(<IssueCommentComposer onSubmit={onSubmit} mentionCandidates={[ADA, BOB]} />)

      await user.type(input(), "hi @")
      expect(await screen.findByTestId("issue-comment-mention-picker")).toBeInTheDocument()
      // Focus moved to the search box, so the person keeps typing the name.
      await user.keyboard("bob")
      await user.keyboard("{Enter}")

      expect(input()).toHaveValue("hi @Bob ")
      await user.keyboard("{Control>}{Enter}{/Control}")
      expect(onSubmit).toHaveBeenCalledWith("hi @Bob", ["usr_bob"])
    })

    it("does not open for an @ inside a word, like an address", async () => {
      const user = userEvent.setup()
      render(<IssueCommentComposer onSubmit={jest.fn()} mentionCandidates={[ADA]} />)
      await user.type(input(), "ops@")
      expect(screen.queryByTestId("issue-comment-mention-picker")).toBeNull()
    })

    it("leaves a typed @ alone when the picker is dismissed", async () => {
      const user = userEvent.setup()
      const onSubmit = jest.fn()
      render(<IssueCommentComposer onSubmit={onSubmit} mentionCandidates={[ADA]} />)
      await user.type(input(), "@")
      await screen.findByTestId("issue-comment-mention-picker")
      await user.keyboard("{Escape}")
      await waitFor(() => expect(screen.queryByTestId("issue-comment-mention-picker")).toBeNull())
      expect(input()).toHaveValue("@")
      await waitFor(() => expect(input()).toHaveFocus())
    })

    it("drops a mention whose name was deleted from the text", async () => {
      const user = userEvent.setup()
      const onSubmit = jest.fn()
      render(<IssueCommentComposer onSubmit={onSubmit} mentionCandidates={[ADA, BOB]} />)

      await user.click(screen.getByRole("button", { name: "detail.mention.trigger" }))
      await user.click(await screen.findByRole("option", { name: "Bob" }))
      await user.click(screen.getByRole("button", { name: "detail.mention.trigger" }))
      await user.click(await screen.findByRole("option", { name: "Ada Lovelace" }))
      expect(input()).toHaveValue("@Bob @Ada Lovelace ")
      expect(screen.getByTestId("issue-comment-mentions")).toHaveTextContent(
        "detail.mention.willNotify(Bob & Ada Lovelace)"
      )

      // Editing Bob's name away drops Bob; Ada's token survives.
      fireEvent.change(input(), { target: { value: "@Ada Lovelace only" } })
      expect(screen.getByTestId("issue-comment-mentions")).toHaveTextContent(
        "detail.mention.willNotify(Ada Lovelace)"
      )
      await user.click(screen.getByTestId("issue-comment-submit"))
      expect(onSubmit).toHaveBeenCalledWith("@Ada Lovelace only", ["usr_ada"])
    })

    it("sends nobody once every inserted name is gone", async () => {
      const user = userEvent.setup()
      const onSubmit = jest.fn()
      render(<IssueCommentComposer onSubmit={onSubmit} mentionCandidates={[BOB]} />)
      await user.click(screen.getByRole("button", { name: "detail.mention.trigger" }))
      await user.click(await screen.findByRole("option", { name: "Bob" }))

      fireEvent.change(input(), { target: { value: "Bob, never mind" } })
      expect(screen.queryByTestId("issue-comment-mentions")).toBeNull()
      await user.click(screen.getByTestId("issue-comment-submit"))
      expect(onSubmit).toHaveBeenCalledWith("Bob, never mind", [])
    })

    it("never turns hand-typed @text into a mention", async () => {
      const user = userEvent.setup()
      const onSubmit = jest.fn()
      render(<IssueCommentComposer onSubmit={onSubmit} mentionCandidates={[BOB]} />)
      await user.type(input(), "x")
      await user.type(input(), " @")
      await user.keyboard("{Escape}")
      await user.type(input(), "Bob")
      await user.click(screen.getByTestId("issue-comment-submit"))
      expect(onSubmit).toHaveBeenCalledWith("x @Bob", [])
      expect(screen.queryByTestId("issue-comment-mentions")).toBeNull()
    })

    it("tells same-named people apart by id", async () => {
      const user = userEvent.setup()
      const onSubmit = jest.fn()
      render(<IssueCommentComposer onSubmit={onSubmit} mentionCandidates={[BOB, BOB_TWO, ADA]} />)
      await user.click(screen.getByRole("button", { name: "detail.mention.trigger" }))
      const options = await screen.findAllByTestId("issue-comment-mention-option")
      expect(options.map((option) => option.textContent)).toEqual([
        "Bobusr_bob",
        "Bobusr_bob2",
        "Ada Lovelace",
      ])
      await user.click(options[1])
      await user.click(screen.getByTestId("issue-comment-submit"))
      expect(onSubmit).toHaveBeenCalledWith("@Bob", ["usr_bob2"])
    })

    it("forgets the mentions once the comment lands", async () => {
      const user = userEvent.setup()
      const onSubmit = jest.fn()
      render(<IssueCommentComposer onSubmit={onSubmit} mentionCandidates={[BOB]} />)
      await user.click(screen.getByRole("button", { name: "detail.mention.trigger" }))
      await user.click(await screen.findByRole("option", { name: "Bob" }))
      await user.click(screen.getByTestId("issue-comment-submit"))
      await waitFor(() => expect(input()).toHaveValue(""))

      await user.type(input(), "x")
      await user.type(input(), " @")
      await user.keyboard("{Escape}")
      await user.type(input(), "Bob again")
      await user.click(screen.getByTestId("issue-comment-submit"))
      expect(onSubmit).toHaveBeenLastCalledWith("x @Bob again", [])
    })
  })
})

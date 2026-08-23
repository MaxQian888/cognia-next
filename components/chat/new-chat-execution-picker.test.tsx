import { fireEvent, render, screen } from "@testing-library/react"

import { NewChatExecutionPicker } from "./new-chat-execution-picker"

describe("NewChatExecutionPicker", () => {
  it("switches between Local and Worktree while retaining the selected base", () => {
    const onChange = jest.fn()
    render(
      <NewChatExecutionPicker
        value={{ location: "managedWorktree", base: { kind: "remoteDefault" } }}
        onChange={onChange}
      />
    )

    expect(screen.getByRole("button", { name: "Worktree" })).toHaveAttribute("aria-pressed", "true")
    expect(screen.getByRole("combobox", { name: "Base" })).toBeInTheDocument()

    fireEvent.click(screen.getByRole("button", { name: "Local" }))
    expect(onChange).toHaveBeenCalledWith({
      location: "local",
      base: { kind: "remoteDefault" },
    })
  })

  it("hides base selection for Local execution", () => {
    render(
      <NewChatExecutionPicker
        value={{ location: "local", base: { kind: "workingState" } }}
        onChange={jest.fn()}
      />
    )

    expect(screen.queryByRole("combobox", { name: "Base" })).not.toBeInTheDocument()
  })
})

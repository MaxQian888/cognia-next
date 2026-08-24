jest.mock("@/lib/git/commands", () => ({
  gitRefs: jest.fn(),
}))

import { fireEvent, render, screen, waitFor } from "@testing-library/react"

import { gitRefs } from "@/lib/git/commands"

import { NewChatExecutionPicker } from "./new-chat-execution-picker"

describe("NewChatExecutionPicker", () => {
  beforeEach(() => {
    ;(gitRefs as jest.Mock).mockReset().mockResolvedValue([
      { name: "main", kind: "branch", targetHash: "aaa" },
      { name: "origin/main", kind: "remoteBranch", targetHash: "bbb" },
    ])
  })

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

  it("switches Local execution into a Worktree and selects common base policies", () => {
    const onChange = jest.fn()
    const { rerender } = render(
      <NewChatExecutionPicker
        value={{ location: "local", base: { kind: "workingState" } }}
        onChange={onChange}
      />
    )

    fireEvent.click(screen.getByRole("button", { name: "Worktree" }))
    expect(onChange).toHaveBeenLastCalledWith({
      location: "managedWorktree",
      base: { kind: "workingState" },
    })

    rerender(
      <NewChatExecutionPicker
        value={{ location: "managedWorktree", base: { kind: "workingState" } }}
        onChange={onChange}
      />
    )
    fireEvent.click(screen.getByRole("combobox", { name: "Base" }))
    fireEvent.click(screen.getByRole("option", { name: "Local HEAD" }))
    expect(onChange).toHaveBeenLastCalledWith({
      location: "managedWorktree",
      base: { kind: "localHead" },
    })

    rerender(
      <NewChatExecutionPicker
        value={{ location: "managedWorktree", base: { kind: "localHead" } }}
        onChange={onChange}
      />
    )
    fireEvent.click(screen.getByRole("combobox", { name: "Base" }))
    fireEvent.click(screen.getByRole("option", { name: "Remote default" }))
    expect(onChange).toHaveBeenLastCalledWith({
      location: "managedWorktree",
      base: { kind: "remoteDefault" },
    })
  })

  it("selects an actual repository ref as the worktree base", async () => {
    const onChange = jest.fn()
    const { rerender } = render(
      <NewChatExecutionPicker
        rootDir="/repo"
        value={{ location: "managedWorktree", base: { kind: "workingState" } }}
        onChange={onChange}
      />
    )
    await waitFor(() => expect(gitRefs).toHaveBeenCalledWith("/repo"))

    fireEvent.click(screen.getByRole("combobox", { name: "Base" }))
    fireEvent.click(screen.getByRole("option", { name: "Git ref" }))
    const gitRefSelection = {
      location: "managedWorktree" as const,
      base: { kind: "gitRef" as const, gitRef: "main" },
    }
    expect(onChange).toHaveBeenLastCalledWith(gitRefSelection)
    rerender(<NewChatExecutionPicker rootDir="/repo" value={gitRefSelection} onChange={onChange} />)

    fireEvent.click(screen.getByRole("combobox", { name: "Git ref" }))
    fireEvent.click(screen.getByTestId("new-chat-git-ref-origin/main"))

    expect(onChange).toHaveBeenLastCalledWith({
      location: "managedWorktree",
      base: { kind: "gitRef", gitRef: "origin/main" },
    })
  })

  it("tolerates ref discovery failures without changing an explicit base", async () => {
    ;(gitRefs as jest.Mock).mockRejectedValueOnce(new Error("offline"))
    const onChange = jest.fn()
    const pullRequest = {
      location: "managedWorktree" as const,
      base: {
        kind: "pullRequest" as const,
        provider: "gitlab",
        repo: "acme/app",
        number: 42,
      },
    }
    render(<NewChatExecutionPicker rootDir="/repo" value={pullRequest} onChange={onChange} />)
    await waitFor(() => expect(gitRefs).toHaveBeenCalledWith("/repo"))

    expect(screen.getByRole("spinbutton", { name: "Pull request number" })).toHaveValue(42)
    expect(onChange).not.toHaveBeenCalled()
  })

  it("captures a provider-neutral pull request base", () => {
    const onChange = jest.fn()
    const { rerender } = render(
      <NewChatExecutionPicker
        value={{ location: "managedWorktree", base: { kind: "workingState" } }}
        onChange={onChange}
      />
    )

    fireEvent.click(screen.getByRole("combobox", { name: "Base" }))
    fireEvent.click(screen.getByRole("option", { name: "Pull request" }))
    const initialPullRequest = {
      location: "managedWorktree" as const,
      base: { kind: "pullRequest" as const, provider: "github", repo: "", number: 1 },
    }
    expect(onChange).toHaveBeenLastCalledWith(initialPullRequest)
    rerender(<NewChatExecutionPicker value={initialPullRequest} onChange={onChange} />)

    fireEvent.change(screen.getByRole("textbox", { name: "Provider" }), {
      target: { value: "gitlab" },
    })
    expect(onChange).toHaveBeenLastCalledWith({
      location: "managedWorktree",
      base: { kind: "pullRequest", provider: "gitlab", repo: "", number: 1 },
    })

    fireEvent.change(screen.getByRole("textbox", { name: "Repository" }), {
      target: { value: "acme/app" },
    })
    expect(onChange).toHaveBeenLastCalledWith({
      location: "managedWorktree",
      base: { kind: "pullRequest", provider: "github", repo: "acme/app", number: 1 },
    })
    const repositoryPullRequest = {
      location: "managedWorktree" as const,
      base: {
        kind: "pullRequest" as const,
        provider: "github",
        repo: "acme/app",
        number: 1,
      },
    }
    rerender(<NewChatExecutionPicker value={repositoryPullRequest} onChange={onChange} />)

    fireEvent.change(screen.getByRole("spinbutton", { name: "Pull request number" }), {
      target: { value: "42" },
    })
    expect(onChange).toHaveBeenLastCalledWith({
      location: "managedWorktree",
      base: { kind: "pullRequest", provider: "github", repo: "acme/app", number: 42 },
    })
  })
})

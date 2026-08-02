import { act, fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { TooltipProvider } from "@/components/ui/tooltip"
import { CommitBox } from "./commit-box"
import { useGitStore } from "@/stores/git/git-store"
import { useSettingsStore } from "@/stores/settings/settings-store"

const mockGenerate = jest.fn().mockResolvedValue("feat: ai message")
jest.mock("@/hooks/git/use-ai-commit-message", () => ({
  useAiCommitMessage: () => ({ generating: false, error: null, generate: mockGenerate }),
}))
jest.mock("./git-identity-dialog", () => ({
  GitIdentityDialog: ({ open, onSaved }: { open: boolean; onSaved: () => void | Promise<void> }) =>
    open ? (
      <button type="button" data-testid="identity-dialog-stub" onClick={() => void onSaved()}>
        save identity
      </button>
    ) : null,
}))

function makeActions() {
  return {
    commit: jest.fn().mockResolvedValue(undefined),
    push: jest.fn().mockResolvedValue(undefined),
    sync: jest.fn().mockResolvedValue(undefined),
    stage: jest.fn().mockResolvedValue(undefined),
  }
}

function setAiEnabled(enabled: boolean) {
  act(() => {
    useSettingsStore.setState({
      settings: enabled
        ? ({
            gitSettings: { commitMessageAI: { enabled: true, conventionalCommits: true } },
          } as never)
        : null,
    })
  })
}

/** Seed the panel prefs (smart commit / post-commit) on the settings singleton. */
function setPanelPrefs(panel: Record<string, unknown>) {
  act(() => {
    useSettingsStore.setState({
      settings: {
        gitSettings: { commitMessageAI: { enabled: false, conventionalCommits: true }, panel },
      } as never,
    })
  })
}

beforeEach(() => {
  jest.clearAllMocks()
  window.localStorage.clear()
  act(() => {
    useGitStore.setState({ commitDraft: {}, commitAmend: false })
  })
  setAiEnabled(false)
})

describe("CommitBox", () => {
  it("disables commit with no message and no staged files", () => {
    render(<CommitBox rootDir="/r" stagedCount={0} committing={false} actions={makeActions()} />)
    expect(screen.getByTestId("commit-button")).toBeDisabled()
  })

  it("enables and commits when message + staged present", async () => {
    const actions = makeActions()
    render(<CommitBox rootDir="/r" stagedCount={2} committing={false} actions={actions} />)
    fireEvent.change(screen.getByTestId("commit-message"), { target: { value: "feat: x" } })
    expect(screen.getByTestId("commit-button")).not.toBeDisabled()
    await act(async () => {
      fireEvent.click(screen.getByTestId("commit-button"))
    })
    expect(actions.commit).toHaveBeenCalledWith("feat: x", { amend: false, signoff: false })
    expect(useGitStore.getState().commitDraft["/r"]).toBe("")
  })

  it("commits on Ctrl+Enter", async () => {
    const actions = makeActions()
    act(() => useGitStore.getState().setCommitDraft("/r", "msg"))
    render(<CommitBox rootDir="/r" stagedCount={1} committing={false} actions={actions} />)
    await act(async () => {
      fireEvent.keyDown(screen.getByTestId("commit-message"), { key: "Enter", ctrlKey: true })
    })
    expect(actions.commit).toHaveBeenCalled()
  })

  it("opens identity recovery and retries the same commit after identity is saved", async () => {
    const actions = makeActions()
    actions.commit
      .mockResolvedValueOnce({
        kind: "identityRequired",
        detail: "Author identity unknown",
      })
      .mockResolvedValueOnce(null)
    render(<CommitBox rootDir="/r" stagedCount={1} committing={false} actions={actions} />)
    fireEvent.change(screen.getByTestId("commit-message"), {
      target: { value: "feat: recover identity" },
    })

    await act(async () => {
      fireEvent.click(screen.getByTestId("commit-button"))
    })
    expect(screen.getByTestId("identity-dialog-stub")).toBeInTheDocument()
    expect(useGitStore.getState().commitDraft["/r"]).toBe("feat: recover identity")

    await act(async () => {
      fireEvent.click(screen.getByTestId("identity-dialog-stub"))
    })
    expect(actions.commit).toHaveBeenCalledTimes(2)
    expect(actions.commit).toHaveBeenLastCalledWith("feat: recover identity", {
      amend: false,
      signoff: false,
    })
    expect(useGitStore.getState().commitDraft["/r"]).toBe("")
  })

  it("recalls a prior commit message with ArrowUp on the first line", async () => {
    const actions = makeActions()
    act(() => useGitStore.getState().setCommitDraft("/r", "feat: one"))
    render(<CommitBox rootDir="/r" stagedCount={1} committing={false} actions={actions} />)
    await act(async () => {
      fireEvent.keyDown(screen.getByTestId("commit-message"), { key: "Enter", ctrlKey: true })
    })
    expect(actions.commit).toHaveBeenCalledWith("feat: one", { amend: false, signoff: false })
    expect(useGitStore.getState().commitDraft["/r"]).toBe("") // cleared after commit
    fireEvent.keyDown(screen.getByTestId("commit-message"), { key: "ArrowUp" })
    expect(useGitStore.getState().commitDraft["/r"]).toBe("feat: one")
  })

  it("leaves caret line-navigation intact: ArrowUp on a lower line doesn't recall", async () => {
    const actions = makeActions()
    // Seed history with one committed message.
    act(() => useGitStore.getState().setCommitDraft("/r", "feat: seed"))
    const { rerender } = render(
      <CommitBox rootDir="/r" stagedCount={1} committing={false} actions={actions} />
    )
    await act(async () => {
      fireEvent.keyDown(screen.getByTestId("commit-message"), { key: "Enter", ctrlKey: true })
    })
    // New multi-line draft; place the caret on the SECOND line.
    act(() => useGitStore.getState().setCommitDraft("/r", "line1\nline2"))
    rerender(<CommitBox rootDir="/r" stagedCount={1} committing={false} actions={actions} />)
    const ta = screen.getByTestId("commit-message") as HTMLTextAreaElement
    ta.setSelectionRange(11, 11) // end of "line2"
    fireEvent.keyDown(ta, { key: "ArrowUp" })
    // Not on the first line → history is NOT engaged; draft is untouched.
    expect(useGitStore.getState().commitDraft["/r"]).toBe("line1\nline2")
  })

  it("shows the amend label when amend is active and allows committing with no staged files", () => {
    act(() => useGitStore.getState().setAmend(true))
    render(<CommitBox rootDir="/r" stagedCount={0} committing={false} actions={makeActions()} />)
    expect(screen.getByTestId("commit-button")).not.toBeDisabled()
  })

  it("hides the AI generate button when the feature is disabled", () => {
    setAiEnabled(false)
    render(<CommitBox rootDir="/r" stagedCount={2} committing={false} actions={makeActions()} />)
    expect(screen.queryByTestId("commit-ai-generate")).not.toBeInTheDocument()
  })

  it("shows and triggers the AI generate button when enabled", async () => {
    setAiEnabled(true)
    render(
      <TooltipProvider>
        <CommitBox rootDir="/r" stagedCount={2} committing={false} actions={makeActions()} />
      </TooltipProvider>
    )
    const btn = screen.getByTestId("commit-ai-generate")
    expect(btn).not.toBeDisabled()
    await act(async () => {
      fireEvent.click(btn)
    })
    expect(mockGenerate).toHaveBeenCalled()
  })

  it("disables the AI generate button with no staged files", () => {
    setAiEnabled(true)
    render(
      <TooltipProvider>
        <CommitBox rootDir="/r" stagedCount={0} committing={false} actions={makeActions()} />
      </TooltipProvider>
    )
    expect(screen.getByTestId("commit-ai-generate")).toBeDisabled()
  })

  it("chains the configured post-commit push after a plain commit", async () => {
    setPanelPrefs({ postCommit: "push" })
    const actions = makeActions()
    render(<CommitBox rootDir="/r" stagedCount={1} committing={false} actions={actions} />)
    fireEvent.change(screen.getByTestId("commit-message"), { target: { value: "feat: x" } })
    await act(async () => {
      fireEvent.click(screen.getByTestId("commit-button"))
    })
    expect(actions.commit).toHaveBeenCalled()
    expect(actions.push).toHaveBeenCalledWith({ setUpstream: true })
  })

  it("supports commit-and-sync plus amend and signoff menu actions", async () => {
    const user = userEvent.setup()
    const actions = makeActions()
    render(<CommitBox rootDir="/r" stagedCount={1} committing={false} actions={actions} />)
    fireEvent.change(screen.getByTestId("commit-message"), { target: { value: "feat: menu" } })

    await user.click(screen.getByTestId("commit-more"))
    await user.click(screen.getByTestId("commit-amend-toggle"))
    await user.click(screen.getByTestId("commit-more"))
    await user.click(screen.getByTestId("commit-signoff-toggle"))
    await user.click(screen.getByTestId("commit-more"))
    await user.click(screen.getByTestId("commit-and-sync"))

    expect(actions.commit).toHaveBeenCalledWith("feat: menu", { amend: true, signoff: true })
    expect(actions.sync).toHaveBeenCalled()
  })

  it("supports the explicit commit-and-push menu action", async () => {
    const user = userEvent.setup()
    const actions = makeActions()
    render(<CommitBox rootDir="/r" stagedCount={1} committing={false} actions={actions} />)
    fireEvent.change(screen.getByTestId("commit-message"), { target: { value: "feat: push" } })

    await user.click(screen.getByTestId("commit-more"))
    await user.click(screen.getByTestId("commit-and-push"))

    expect(actions.push).toHaveBeenCalledWith({ setUpstream: true })
  })

  it("does not chain a post-commit action by default", async () => {
    const actions = makeActions()
    render(<CommitBox rootDir="/r" stagedCount={1} committing={false} actions={actions} />)
    fireEvent.change(screen.getByTestId("commit-message"), { target: { value: "feat: x" } })
    await act(async () => {
      fireEvent.click(screen.getByTestId("commit-button"))
    })
    expect(actions.push).not.toHaveBeenCalled()
    expect(actions.sync).not.toHaveBeenCalled()
  })

  it("smart commit stages all changes when nothing is staged, then commits", async () => {
    setPanelPrefs({ smartCommit: true })
    act(() => {
      useGitStore.getState().setStatus({
        branch: "main",
        upstream: null,
        ahead: 0,
        behind: 0,
        staged: [],
        changes: [
          { path: "a.ts", status: "modified" },
          { path: "b.ts", status: "modified" },
        ],
        merge: [],
        isRebasing: false,
        isMerging: false,
      } as never)
    })
    const actions = makeActions()
    // stagedCount is 0, but smart commit + unstaged changes → commit is enabled.
    render(<CommitBox rootDir="/r" stagedCount={0} committing={false} actions={actions} />)
    fireEvent.change(screen.getByTestId("commit-message"), { target: { value: "feat: all" } })
    expect(screen.getByTestId("commit-button")).not.toBeDisabled()
    await act(async () => {
      fireEvent.click(screen.getByTestId("commit-button"))
    })
    expect(actions.stage).toHaveBeenCalledWith(["a.ts", "b.ts"])
    expect(actions.commit).toHaveBeenCalledWith("feat: all", { amend: false, signoff: false })
  })

  it("does not commit or clear the draft when smart staging fails", async () => {
    setPanelPrefs({ smartCommit: true })
    act(() => {
      useGitStore.getState().setStatus({
        branch: "main",
        upstream: null,
        ahead: 0,
        behind: 0,
        staged: [],
        changes: [{ path: "a.ts", status: "modified" }],
        merge: [],
        isRebasing: false,
        isMerging: false,
      } as never)
    })
    const actions = makeActions()
    actions.stage.mockResolvedValue({ kind: "lockHeld", detail: "index.lock exists" })
    render(<CommitBox rootDir="/r" stagedCount={0} committing={false} actions={actions} />)
    fireEvent.change(screen.getByTestId("commit-message"), { target: { value: "feat: keep me" } })

    await act(async () => {
      fireEvent.click(screen.getByTestId("commit-button"))
    })

    expect(actions.commit).not.toHaveBeenCalled()
    expect(useGitStore.getState().commitDraft["/r"]).toBe("feat: keep me")
  })
})

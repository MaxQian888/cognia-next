import { act, fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { TooltipProvider } from "@/components/ui/tooltip"
import { SyncToolbar } from "./sync-toolbar"
import { useGitStore } from "@/stores/git/git-store"

function makeActions() {
  return {
    fetch: jest.fn().mockResolvedValue(undefined),
    pull: jest.fn().mockResolvedValue(undefined),
    push: jest.fn().mockResolvedValue(undefined),
    sync: jest.fn().mockResolvedValue(undefined),
    discardAll: jest.fn().mockResolvedValue(undefined),
    mergeAbort: jest.fn().mockResolvedValue(undefined),
    reset: jest.fn().mockResolvedValue(undefined),
  }
}

function setStatus(overrides: Partial<import("@/types/git").GitStatus>) {
  act(() =>
    useGitStore.getState().setStatus({
      branch: "main",
      upstream: "origin/main",
      ahead: 0,
      behind: 0,
      staged: [],
      changes: [],
      merge: [],
      isRebasing: false,
      isMerging: false,
      ...overrides,
    })
  )
}

function renderToolbar(actions = makeActions(), handlers = {}) {
  const props = {
    actions,
    onOpenStash: jest.fn(),
    onOpenTimeline: jest.fn(),
    onOpenRemotes: jest.fn(),
    onOpenTags: jest.fn(),
    onOpenCompare: jest.fn(),
    onRefresh: jest.fn(),
    ...handlers,
  }
  render(
    <TooltipProvider>
      <SyncToolbar {...props} />
    </TooltipProvider>
  )
  return props
}

beforeEach(() => {
  act(() => useGitStore.getState().reset())
})

describe("SyncToolbar", () => {
  it("fires network actions", () => {
    const actions = makeActions()
    renderToolbar(actions)
    fireEvent.click(screen.getByTestId("sync-sync"))
    fireEvent.click(screen.getByTestId("sync-pull"))
    fireEvent.click(screen.getByTestId("sync-push"))
    fireEvent.click(screen.getByTestId("sync-fetch"))
    expect(actions.sync).toHaveBeenCalled()
    expect(actions.pull).toHaveBeenCalled()
    expect(actions.push).toHaveBeenCalled()
    expect(actions.fetch).toHaveBeenCalled()
  })

  it("disables a button while its op is busy", () => {
    act(() => useGitStore.getState().setOp("push", true))
    renderToolbar()
    expect(screen.getByTestId("sync-push")).toBeDisabled()
  })

  it("opens overflow actions", async () => {
    const user = userEvent.setup()
    const props = renderToolbar()
    await user.click(screen.getByTestId("sync-more"))
    const refresh = await screen.findByTestId("more-refresh")
    await user.click(refresh)
    expect(props.onRefresh).toHaveBeenCalled()
  })

  it("opens the remotes panel from the overflow menu", async () => {
    const user = userEvent.setup()
    const props = renderToolbar()
    await user.click(screen.getByTestId("sync-more"))
    await user.click(await screen.findByTestId("more-remotes"))
    expect(props.onOpenRemotes).toHaveBeenCalled()
  })

  it("opens the compare-refs sheet from the overflow menu", async () => {
    const user = userEvent.setup()
    const props = renderToolbar()
    await user.click(screen.getByTestId("sync-more"))
    await user.click(await screen.findByTestId("more-compare"))
    expect(props.onOpenCompare).toHaveBeenCalled()
  })

  it("keeps the overflow menu mounted when an overlay item is selected (preventDefault)", async () => {
    const user = userEvent.setup()
    const props = renderToolbar()
    await user.click(screen.getByTestId("sync-more"))
    await user.click(await screen.findByTestId("more-stash"))
    expect(props.onOpenStash).toHaveBeenCalled()
    // preventDefault keeps the menu open so the Sheet never races focus restore.
    expect(screen.getByTestId("more-stash")).toBeInTheDocument()
  })

  it("shows Publish Branch instead of Push when the branch has no upstream", () => {
    setStatus({ upstream: null })
    const actions = makeActions()
    renderToolbar(actions)
    expect(screen.queryByTestId("sync-push")).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId("sync-publish"))
    expect(actions.push).toHaveBeenCalledWith(true)
  })

  it("shows the plain Push button when an upstream is configured", () => {
    setStatus({})
    renderToolbar()
    expect(screen.getByTestId("sync-push")).toBeInTheDocument()
    expect(screen.queryByTestId("sync-publish")).not.toBeInTheDocument()
  })

  it("undo last commit soft-resets to HEAD~1", async () => {
    const user = userEvent.setup()
    const actions = makeActions()
    renderToolbar(actions)
    await user.click(screen.getByTestId("sync-more"))
    await user.click(await screen.findByTestId("more-undo-commit"))
    expect(actions.reset).toHaveBeenCalledWith("soft", "HEAD~1")
  })

  it("disables undo last commit while a sequencer operation is in progress", async () => {
    act(() =>
      useGitStore.setState({
        repoState: {
          isRepo: true,
          rootDir: "/r",
          detachedHead: false,
          operationInProgress: "merge",
        },
      })
    )
    const user = userEvent.setup()
    const actions = makeActions()
    renderToolbar(actions)
    await user.click(screen.getByTestId("sync-more"))
    const item = await screen.findByTestId("more-undo-commit")
    expect(item).toHaveAttribute("data-disabled")
    await user.click(item)
    expect(actions.reset).not.toHaveBeenCalled()
  })

  it("hides Abort Merge unless a merge is in progress", async () => {
    const user = userEvent.setup()
    renderToolbar()
    await user.click(screen.getByTestId("sync-more"))
    expect(screen.queryByTestId("more-abort-merge")).not.toBeInTheDocument()
  })

  it("aborts a merge when one is in progress", async () => {
    const user = userEvent.setup()
    act(() =>
      useGitStore.getState().setStatus({
        branch: "main",
        upstream: null,
        ahead: 0,
        behind: 0,
        staged: [],
        changes: [],
        merge: [],
        isRebasing: false,
        isMerging: true,
      })
    )
    const actions = makeActions()
    renderToolbar(actions)
    await user.click(screen.getByTestId("sync-more"))
    await user.click(await screen.findByTestId("more-abort-merge"))
    expect(actions.mergeAbort).toHaveBeenCalled()
  })
})

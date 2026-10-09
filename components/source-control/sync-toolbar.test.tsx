import { act, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { TooltipProvider } from "@/components/ui/tooltip"
import { SyncToolbar } from "./sync-toolbar"
import { useGitStore } from "@/stores/git/git-store"
import { useSettingsStore } from "@/stores/settings/settings-store"

/** Set panel prefs (confirm toggles) on the settings singleton. */
function setPanelPrefs(panel: Record<string, unknown>) {
  act(() => {
    useSettingsStore.setState({
      settings: {
        gitSettings: { commitMessageAI: { enabled: false, conventionalCommits: true }, panel },
      } as never,
    })
  })
}

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

function renderToolbarWithUnmount(actions = makeActions(), handlers = {}) {
  let unmount: () => void = () => {}
  const props = renderToolbar(actions, handlers, (u) => (unmount = u))
  return { props, unmount: () => unmount() }
}

function renderToolbar(
  actions = makeActions(),
  handlers = {},
  onUnmount?: (unmount: () => void) => void
) {
  const props = {
    actions,
    onOpenStash: jest.fn(),
    onOpenTimeline: jest.fn(),
    onOpenRemotes: jest.fn(),
    onOpenTags: jest.fn(),
    onOpenCompare: jest.fn(),
    onOpenWorktrees: jest.fn(),
    onRefresh: jest.fn(),
    ...handlers,
  }
  const { unmount } = render(
    <TooltipProvider>
      <SyncToolbar {...props} />
    </TooltipProvider>
  )
  onUnmount?.(unmount)
  return props
}

beforeEach(() => {
  act(() => {
    useGitStore.getState().reset()
    useSettingsStore.setState({ settings: null as never })
  })
})

describe("SyncToolbar", () => {
  /** Open the sync split button's menu. */
  async function openSyncMenu(user: ReturnType<typeof userEvent.setup>) {
    await user.click(screen.getByTestId("sync-menu"))
  }

  describe("primary action", () => {
    it.each([
      [{ ahead: 0, behind: 0 }, "fetch"],
      [{ ahead: 0, behind: 3 }, "pull"],
      [{ ahead: 2, behind: 0 }, "push"],
      [{ ahead: 2, behind: 3 }, "sync"],
      [{ upstream: null, ahead: 1 }, "publish"],
    ] as const)("offers %o as %s", (state, intent) => {
      setStatus(state)
      renderToolbar()
      expect(screen.getByTestId("sync-primary")).toHaveAttribute("data-intent", intent)
    })

    it("labels the action, shows the counts, and says it in a sentence", () => {
      setStatus({ ahead: 2, behind: 3 })
      renderToolbar()
      const primary = screen.getByTestId("sync-primary")
      expect(primary).toHaveTextContent("Sync")
      expect(screen.getByTestId("sync-behind")).toHaveTextContent("3")
      expect(screen.getByTestId("sync-ahead")).toHaveTextContent("2")
      expect(primary).toHaveAccessibleName("Pull 3 commits and push 2 commits with origin/main")
    })

    it("runs what it offers, with the default prefs", async () => {
      const user = userEvent.setup()
      setPanelPrefs({ pullRebase: true, fetchPrune: true })
      const actions = makeActions()

      setStatus({ behind: 1 })
      const { unmount } = renderToolbarWithUnmount(actions)
      await user.click(screen.getByTestId("sync-primary"))
      expect(actions.pull).toHaveBeenCalledWith({ rebase: true })
      unmount()

      setStatus({})
      renderToolbar(actions)
      await user.click(screen.getByTestId("sync-primary"))
      expect(actions.fetch).toHaveBeenCalledWith({ prune: true })
    })

    it("publishes a branch with no upstream", async () => {
      const user = userEvent.setup()
      setStatus({ upstream: null })
      const actions = makeActions()
      renderToolbar(actions)
      await user.click(screen.getByTestId("sync-primary"))
      expect(actions.push).toHaveBeenCalledWith({ setUpstream: true })
    })

    it("pushes and synchronizes", async () => {
      const user = userEvent.setup()
      const actions = makeActions()
      setStatus({ ahead: 1 })
      const { unmount } = renderToolbarWithUnmount(actions)
      await user.click(screen.getByTestId("sync-primary"))
      expect(actions.push).toHaveBeenCalledWith()
      unmount()
      setStatus({ ahead: 1, behind: 1 })
      renderToolbar(actions)
      await user.click(screen.getByTestId("sync-primary"))
      expect(actions.sync).toHaveBeenCalled()
    })

    it("spins and waits while any network operation runs", () => {
      act(() => useGitStore.getState().setOp("push", true))
      renderToolbar()
      expect(screen.getByTestId("sync-primary")).toBeDisabled()
    })

    it("keeps the counts but drops the word when dense", () => {
      setStatus({ behind: 4 })
      renderToolbar(makeActions(), { dense: true })
      const primary = screen.getByTestId("sync-primary")
      expect(primary).not.toHaveTextContent("Pull")
      expect(screen.getByTestId("sync-behind")).toHaveTextContent("4")
      // The name still says what it does.
      expect(primary).toHaveAccessibleName("Pull 4 commits from origin/main")
    })
  })

  describe("sync menu", () => {
    it("offers every network action by name", async () => {
      const user = userEvent.setup()
      setStatus({ ahead: 1, behind: 2 })
      const actions = makeActions()
      renderToolbar(actions)
      for (const [id, action] of [
        ["sync-fetch", actions.fetch],
        ["sync-pull", actions.pull],
        ["sync-push", actions.push],
        ["sync-sync", actions.sync],
      ] as const) {
        await openSyncMenu(user)
        await user.click(await screen.findByTestId(id))
        expect(action).toHaveBeenCalled()
      }
    })

    it("names the tracking branch and shows the counts on their rows", async () => {
      const user = userEvent.setup()
      setStatus({ ahead: 1, behind: 2 })
      renderToolbar()
      await openSyncMenu(user)
      expect(await screen.findByText("Tracking origin/main")).toBeInTheDocument()
      expect(screen.getByTestId("sync-pull")).toHaveTextContent("2")
      expect(screen.getByTestId("sync-push")).toHaveTextContent("1")
    })

    it("shows Publish Branch instead of Push when the branch has no upstream", async () => {
      const user = userEvent.setup()
      setStatus({ upstream: null })
      const actions = makeActions()
      renderToolbar(actions)
      await openSyncMenu(user)
      expect(screen.queryByTestId("sync-push")).not.toBeInTheDocument()
      await user.click(await screen.findByTestId("sync-publish"))
      expect(actions.push).toHaveBeenCalledWith({ setUpstream: true })
    })

    it("shows the plain Push item when an upstream is configured", async () => {
      const user = userEvent.setup()
      setStatus({})
      renderToolbar()
      await openSyncMenu(user)
      expect(await screen.findByTestId("sync-push")).toBeInTheDocument()
      expect(screen.queryByTestId("sync-publish")).not.toBeInTheDocument()
    })

    it("disables an item while its op is busy", async () => {
      const user = userEvent.setup()
      act(() => useGitStore.getState().setOp("push", true))
      renderToolbar()
      await openSyncMenu(user)
      expect(await screen.findByTestId("sync-push")).toHaveAttribute("data-disabled")
    })

    it("pulls with rebase", async () => {
      const user = userEvent.setup()
      const actions = makeActions()
      renderToolbar(actions)
      await openSyncMenu(user)
      await user.click(await screen.findByTestId("more-pull-rebase"))
      expect(actions.pull).toHaveBeenCalledWith({ rebase: true })
    })

    it("fetches with prune", async () => {
      const user = userEvent.setup()
      const actions = makeActions()
      renderToolbar(actions)
      await openSyncMenu(user)
      await user.click(await screen.findByTestId("more-fetch-prune"))
      expect(actions.fetch).toHaveBeenCalledWith({ prune: true })
    })

    it("force pushes behind a confirm dialog (with lease)", async () => {
      setStatus({}) // has an upstream → force push is enabled
      const user = userEvent.setup()
      const actions = makeActions()
      renderToolbar(actions)
      await openSyncMenu(user)
      await user.click(await screen.findByTestId("more-force-push"))
      // Guarded — nothing pushed until confirmed.
      expect(actions.push).not.toHaveBeenCalled()
      await user.click(await screen.findByTestId("force-push-confirm-action"))
      expect(actions.push).toHaveBeenCalledWith({ forceWithLease: true })
    })

    it("force pushes immediately when its confirm pref is off", async () => {
      setStatus({})
      setPanelPrefs({ confirmForcePush: false })
      const user = userEvent.setup()
      const actions = makeActions()
      renderToolbar(actions)
      await openSyncMenu(user)
      await user.click(await screen.findByTestId("more-force-push"))
      expect(actions.push).toHaveBeenCalledWith({ forceWithLease: true })
    })

    it("disables force push when the branch has no upstream", async () => {
      setStatus({ upstream: null })
      const user = userEvent.setup()
      renderToolbar()
      await openSyncMenu(user)
      expect(await screen.findByTestId("more-force-push")).toHaveAttribute("data-disabled")
    })
  })

  describe("more menu", () => {
    it("refreshes", async () => {
      const user = userEvent.setup()
      const props = renderToolbar()
      await user.click(screen.getByTestId("sync-more"))
      await user.click(await screen.findByTestId("more-refresh"))
      expect(props.onRefresh).toHaveBeenCalled()
    })

    it("groups its items under labelled sections", async () => {
      const user = userEvent.setup()
      renderToolbar()
      await user.click(screen.getByTestId("sync-more"))
      expect(await screen.findByText("Repository")).toBeInTheDocument()
      expect(screen.getByText("Commits")).toBeInTheDocument()
    })

    it("does not repeat the network actions the sync button owns", async () => {
      const user = userEvent.setup()
      renderToolbar()
      await user.click(screen.getByTestId("sync-more"))
      await screen.findByTestId("more-refresh")
      for (const id of ["sync-pull", "sync-push", "sync-fetch", "more-pull-rebase"]) {
        expect(screen.queryByTestId(id)).not.toBeInTheDocument()
      }
    })

    it.each([
      ["more-remotes", "onOpenRemotes"],
      ["more-compare", "onOpenCompare"],
      ["more-worktrees", "onOpenWorktrees"],
      ["more-timeline", "onOpenTimeline"],
      ["more-tags", "onOpenTags"],
    ] as const)("%s opens its panel", async (id, handler) => {
      const user = userEvent.setup()
      const props = renderToolbar()
      await user.click(screen.getByTestId("sync-more"))
      await user.click(await screen.findByTestId(id))
      expect(props[handler]).toHaveBeenCalled()
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
      await screen.findByTestId("more-refresh")
      expect(screen.queryByTestId("more-abort-merge")).not.toBeInTheDocument()
    })

    it("aborts a merge when one is in progress", async () => {
      const user = userEvent.setup()
      setStatus({ upstream: null, isMerging: true })
      const actions = makeActions()
      renderToolbar(actions)
      await user.click(screen.getByTestId("sync-more"))
      await user.click(await screen.findByTestId("more-abort-merge"))
      expect(actions.mergeAbort).toHaveBeenCalled()
    })

    it("confirms before discarding all", async () => {
      const user = userEvent.setup()
      const actions = makeActions()
      renderToolbar(actions)
      await user.click(screen.getByTestId("sync-more"))
      await user.click(await screen.findByTestId("more-discard-all"))
      expect(actions.discardAll).not.toHaveBeenCalled()
      // The confirmation names what else goes: untracked files.
      expect(screen.getByTestId("discard-confirm")).toHaveTextContent(/untracked files/i)
      await user.click(await screen.findByTestId("discard-confirm-action"))
      // Same meaning as the Changes group's "Discard All": untracked included.
      expect(actions.discardAll).toHaveBeenCalledWith(true)
    })
  })

  it("gates every control by its exact command", async () => {
    const user = userEvent.setup()
    const actions = { ...makeActions(), can: jest.fn().mockReturnValue(false) }
    renderToolbar(actions)
    expect(screen.getByTestId("sync-primary")).toBeDisabled()
    await openSyncMenu(user)
    for (const id of [
      "sync-sync",
      "sync-pull",
      "sync-push",
      "sync-fetch",
      "more-pull-rebase",
      "more-fetch-prune",
      "more-force-push",
    ]) {
      expect(await screen.findByTestId(id)).toHaveAttribute("data-disabled")
    }
    await user.keyboard("{Escape}")
    await user.click(screen.getByTestId("sync-more"))
    expect(await screen.findByTestId("more-discard-all")).toHaveAttribute("data-disabled")
  })
})

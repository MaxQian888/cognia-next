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
  }
}

function renderToolbar(actions = makeActions(), handlers = {}) {
  const props = {
    actions,
    onOpenStash: jest.fn(),
    onOpenTimeline: jest.fn(),
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
})

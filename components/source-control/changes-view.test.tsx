import { act, fireEvent, render, screen } from "@testing-library/react"
import { ChangesView } from "./changes-view"
import { useGitStore } from "@/stores/git/git-store"
import type { GitStatus } from "@/types/git"
import type { UseGitActionsResult } from "@/hooks/git/use-git-actions"

const status: GitStatus = {
  branch: "main",
  upstream: null,
  ahead: 0,
  behind: 0,
  staged: [
    { path: "staged.ts", origPath: null, status: "modified", staged: true, group: "staged" },
  ],
  changes: [
    { path: "work.ts", origPath: null, status: "modified", staged: false, group: "changes" },
  ],
  merge: [{ path: "conf.ts", origPath: null, status: "conflicted", staged: false, group: "merge" }],
  isRebasing: false,
  isMerging: true,
}

function makeActions(): UseGitActionsResult {
  return {
    stage: jest.fn().mockResolvedValue(undefined),
    unstage: jest.fn().mockResolvedValue(undefined),
    discard: jest.fn().mockResolvedValue(undefined),
    discardAll: jest.fn().mockResolvedValue(undefined),
    commit: jest.fn().mockResolvedValue(undefined),
    checkout: jest.fn(),
    createBranch: jest.fn(),
    deleteBranch: jest.fn(),
    renameBranch: jest.fn(),
    fetch: jest.fn(),
    pull: jest.fn(),
    push: jest.fn(),
    sync: jest.fn(),
    stashPush: jest.fn(),
    stashPop: jest.fn(),
    stashApply: jest.fn(),
    stashDrop: jest.fn(),
    resolveConflict: jest.fn(),
    mergeAbort: jest.fn(),
    remoteAdd: jest.fn().mockResolvedValue(undefined),
    remoteRemove: jest.fn().mockResolvedValue(undefined),
    createTag: jest.fn().mockResolvedValue(undefined),
    deleteTag: jest.fn().mockResolvedValue(undefined),
    pushTag: jest.fn().mockResolvedValue(undefined),
    reset: jest.fn().mockResolvedValue(undefined),
    restore: jest.fn().mockResolvedValue(undefined),
    rebase: jest.fn().mockResolvedValue(undefined),
    cherryPick: jest.fn().mockResolvedValue(undefined),
    revert: jest.fn().mockResolvedValue(undefined),
    sequencerContinue: jest.fn().mockResolvedValue(undefined),
    sequencerAbort: jest.fn().mockResolvedValue(undefined),
    interactiveRebase: jest.fn().mockResolvedValue(undefined),
  }
}

beforeEach(() => {
  act(() => {
    useGitStore.getState().reset()
    useGitStore.setState({ expandedGroups: { merge: true, staged: true, changes: true } })
  })
})

describe("ChangesView", () => {
  it("renders all three groups", () => {
    render(
      <ChangesView
        rootDir="/r"
        status={status}
        actions={makeActions()}
        committing={false}
        selectedPath={null}
        onSelectFile={() => {}}
        onViewHistory={() => {}}
        onViewBlame={() => {}}
        onRestore={() => {}}
      />
    )
    expect(screen.getByTestId("change-group-merge")).toBeInTheDocument()
    expect(screen.getByTestId("change-group-staged")).toBeInTheDocument()
    expect(screen.getByTestId("change-group-changes")).toBeInTheDocument()
  })

  it("stages all unstaged changes", () => {
    const actions = makeActions()
    render(
      <ChangesView
        rootDir="/r"
        status={status}
        actions={actions}
        committing={false}
        selectedPath={null}
        onSelectFile={() => {}}
        onViewHistory={() => {}}
        onViewBlame={() => {}}
        onRestore={() => {}}
      />
    )
    fireEvent.click(screen.getByTestId("group-action-changes-stage-all"))
    expect(actions.stage).toHaveBeenCalledWith(["work.ts"])
  })

  it("selects a file with the correct staged flag", () => {
    const onSelectFile = jest.fn()
    render(
      <ChangesView
        rootDir="/r"
        status={status}
        actions={makeActions()}
        committing={false}
        selectedPath={null}
        onSelectFile={onSelectFile}
        onViewHistory={() => {}}
        onViewBlame={() => {}}
        onRestore={() => {}}
      />
    )
    fireEvent.click(screen.getByTestId("change-item-staged.ts"))
    expect(onSelectFile).toHaveBeenCalledWith("staged.ts", true)
    fireEvent.click(screen.getByTestId("change-item-work.ts"))
    expect(onSelectFile).toHaveBeenCalledWith("work.ts", false)
  })

  it("shows empty state with no changes", () => {
    const empty: GitStatus = { ...status, staged: [], changes: [], merge: [] }
    render(
      <ChangesView
        rootDir="/r"
        status={empty}
        actions={makeActions()}
        committing={false}
        selectedPath={null}
        onSelectFile={() => {}}
        onViewHistory={() => {}}
        onViewBlame={() => {}}
        onRestore={() => {}}
      />
    )
    expect(screen.getByTestId("no-changes")).toBeInTheDocument()
  })
})

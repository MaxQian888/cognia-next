/**
 * @jest-environment jsdom
 */

import { act, fireEvent, render, screen } from "@testing-library/react"
import type { ReactNode } from "react"

let mockWidth = 0
jest.mock("@/hooks/use-element-width", () => ({ useElementWidth: () => mockWidth }))
jest.mock("@/hooks/ui/use-resizable-layout", () => ({
  useResizableLayout: () => ({ defaultLayout: undefined, onLayoutChanged: jest.fn() }),
}))
jest.mock("@/components/ui/resizable", () => ({
  ResizablePanelGroup: ({ children }: { children: ReactNode }) => (
    <div data-testid="split-group">{children}</div>
  ),
  ResizablePanel: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  ResizableHandle: () => <div />,
}))
jest.mock("@/components/source-control/changes-view", () => ({
  ChangesView: ({
    onSelectFile,
    selectedPath,
    density,
    status,
  }: {
    onSelectFile: (path: string, staged: boolean) => void
    selectedPath: string | null
    density: string
    status: { changes: { path: string }[]; staged: { path: string }[] }
  }) => (
    <div
      data-testid="changes"
      data-selected={selectedPath ?? ""}
      data-density={density}
      data-paths={[...status.staged, ...status.changes].map((c) => c.path).join(",")}
    >
      <button data-testid="pick-b" onClick={() => onSelectFile("b.ts", false)} />
      <textarea data-testid="comment-box" />
    </div>
  ),
}))
jest.mock("@/components/source-control/diff-pane", () => ({
  DiffPane: ({
    path,
    staged,
    leading,
    reviewDefaultCollapsed,
  }: {
    path: string
    staged: boolean
    leading?: ReactNode
    reviewDefaultCollapsed?: boolean
  }) => (
    <div
      data-testid="diff"
      data-path={path}
      data-staged={String(staged)}
      data-review-collapsed={String(Boolean(reviewDefaultCollapsed))}
    >
      {leading}
    </div>
  ),
}))

jest.mock("@/components/source-control/review-scope-picker", () => ({
  ReviewScopePicker: ({
    value,
    onChange,
    allowConversation,
    counts,
  }: {
    value: { scope: string }
    onChange: (next: unknown) => void
    allowConversation?: boolean
    counts?: Record<string, number>
  }) => (
    <div
      data-testid="scope-picker"
      data-value={JSON.stringify(value)}
      data-conversation={String(Boolean(allowConversation))}
      data-counts={JSON.stringify(counts ?? {})}
    >
      {["uncommitted", "unstaged", "staged", "conversation"].map((scope) => (
        <button key={scope} data-testid={`pick-${scope}`} onClick={() => onChange({ scope })} />
      ))}
      <button
        data-testid="pick-turn"
        onClick={() => onChange({ scope: "lastTurn", runId: "run:1" })}
      />
    </div>
  ),
}))
jest.mock("./snapshot-review", () => ({
  isSnapshotSelection: (choice: { scope: string }) =>
    choice.scope === "lastTurn" || choice.scope === "commit" || choice.scope === "branch",
  SnapshotReview: ({
    selection,
    focusPath,
    header,
  }: {
    selection: unknown
    focusPath: string | null
    header: ReactNode
  }) => (
    <div
      data-testid="snapshot-review"
      data-selection={JSON.stringify(selection)}
      data-focus={focusPath ?? ""}
    >
      {header}
    </div>
  ),
}))

let mockConversationPaths: Set<string> = new Set()
let mockConversationReady = true
jest.mock("@/hooks/git/use-conversation-changed-paths", () => ({
  useConversationChangedPaths: () => ({
    paths: mockConversationPaths,
    ready: mockConversationReady,
  }),
}))
jest.mock("@/components/source-control/commit-box", () => ({
  CommitBox: ({
    stagedCount,
    compact,
    density,
  }: {
    stagedCount: number
    compact?: boolean
    density?: string
  }) => (
    <div
      data-testid="commit-box"
      data-staged={stagedCount}
      data-compact={String(Boolean(compact))}
      data-density={density}
    />
  ),
}))

import { REVIEW_SPLIT_MIN_WIDTH, WorkspaceReview } from "./workspace-review"
import type { UseGitActionsResult } from "@/hooks/git/use-git-actions"
import type { GitStatus } from "@/types/git"

function change(path: string, group: "staged" | "changes" | "merge") {
  return { path, origPath: null, status: "modified" as const, staged: group === "staged", group }
}

function status(changes: string[], staged: string[] = []): GitStatus {
  return {
    branch: "main",
    upstream: null,
    ahead: 0,
    behind: 0,
    staged: staged.map((p) => change(p, "staged")),
    changes: changes.map((p) => change(p, "changes")),
    merge: [],
    isRebasing: false,
    isMerging: false,
  }
}

const actions = {} as UseGitActionsResult

function renderReview(props: Partial<Parameters<typeof WorkspaceReview>[0]> = {}) {
  const onSelect = jest.fn()
  const utils = render(
    <WorkspaceReview
      rootPath="/repo"
      status={status(["a.ts", "b.ts", "c.ts"])}
      actions={actions}
      committing={false}
      selected={null}
      onSelect={onSelect}
      layout="desktop"
      {...props}
      {...(props.onSelect ? {} : { onSelect })}
    />
  )
  return { ...utils, onSelect: (props.onSelect ?? onSelect) as jest.Mock }
}

beforeEach(() => {
  mockWidth = 0
  mockConversationPaths = new Set()
  mockConversationReady = true
})

describe("WorkspaceReview layout", () => {
  it("puts list and diff side by side in a wide dock", () => {
    mockWidth = REVIEW_SPLIT_MIN_WIDTH
    renderReview({ selected: { path: "a.ts", staged: false } })
    expect(screen.getByTestId("workspace-review")).toHaveAttribute("data-layout", "split")
    expect(screen.getByTestId("changes")).toBeInTheDocument()
    expect(screen.getByTestId("diff")).toHaveAttribute("data-review-collapsed", "false")
    // No Back in a split: the list is right there.
    expect(screen.queryByTestId("workspace-review-back")).toBeNull()
  })

  it("keeps the split before the first measurement", () => {
    renderReview({ selected: { path: "a.ts", staged: false } })
    expect(screen.getByTestId("workspace-review")).toHaveAttribute("data-layout", "split")
  })

  it("takes turns in a narrow dock, list first", () => {
    mockWidth = REVIEW_SPLIT_MIN_WIDTH - 1
    renderReview({ selected: { path: "a.ts", staged: false } })
    expect(screen.getByTestId("workspace-review")).toHaveAttribute("data-layout", "stacked")
    expect(screen.getByTestId("changes")).toHaveAttribute("data-density", "compact")
    expect(screen.queryByTestId("diff")).toBeNull()
  })

  it("always takes turns on a phone, with touch density", () => {
    mockWidth = 2000
    renderReview({ layout: "mobile" })
    expect(screen.getByTestId("workspace-review")).toHaveAttribute("data-layout", "stacked")
    expect(screen.getByTestId("changes")).toHaveAttribute("data-density", "touch")
  })

  it("shows the empty state before status loads", () => {
    renderReview({ status: null })
    expect(screen.queryByTestId("changes")).toBeNull()
    expect(screen.getByText("Select a changed file to review its diff")).toBeInTheDocument()
  })
})

describe("WorkspaceReview stacked flow", () => {
  beforeEach(() => {
    mockWidth = 500
  })

  it("opens a picked file's diff and goes back to the list", () => {
    const { onSelect, rerender } = renderReview()
    fireEvent.click(screen.getByTestId("pick-b"))
    expect(onSelect).toHaveBeenCalledWith({ path: "b.ts", staged: false })
    rerender(
      <WorkspaceReview
        rootPath="/repo"
        status={status(["a.ts", "b.ts", "c.ts"])}
        actions={actions}
        committing={false}
        selected={{ path: "b.ts", staged: false }}
        onSelect={onSelect}
        layout="desktop"
      />
    )
    expect(screen.getByTestId("diff")).toHaveAttribute("data-path", "b.ts")
    expect(screen.getByTestId("diff")).toHaveAttribute("data-review-collapsed", "true")
    fireEvent.click(screen.getByTestId("workspace-review-back"))
    expect(screen.getByTestId("changes")).toHaveAttribute("data-selected", "b.ts")
  })

  it("opens the diff for each new reveal focus", () => {
    const file = { path: "c.ts", staged: false }
    const { rerender, onSelect } = renderReview({ selected: file, focus: { id: "r1", file } })
    expect(screen.getByTestId("diff")).toHaveAttribute("data-path", "c.ts")
    fireEvent.click(screen.getByTestId("workspace-review-back"))
    expect(screen.getByTestId("changes")).toBeInTheDocument()
    // The same reveal again does nothing; a new one opens the diff.
    const next = (id: string) => (
      <WorkspaceReview
        rootPath="/repo"
        status={status(["a.ts", "b.ts", "c.ts"])}
        actions={actions}
        committing={false}
        selected={file}
        onSelect={onSelect}
        layout="desktop"
        focus={{ id, file }}
      />
    )
    rerender(next("r1"))
    expect(screen.getByTestId("changes")).toBeInTheDocument()
    rerender(next("r2"))
    expect(screen.getByTestId("diff")).toBeInTheDocument()
  })

  it("does not pick a file for the reader in the stacked list", () => {
    const { onSelect } = renderReview()
    expect(onSelect).not.toHaveBeenCalled()
  })
})

describe("WorkspaceReview file navigation", () => {
  beforeEach(() => {
    mockWidth = 1000
  })

  it("picks the first file when a wide review opens empty", () => {
    const { onSelect } = renderReview()
    expect(onSelect).toHaveBeenCalledWith({ path: "a.ts", staged: false })
  })

  it("steps between files with the toolbar buttons and shows the position", () => {
    const { onSelect } = renderReview({ selected: { path: "b.ts", staged: false } })
    expect(screen.getByTestId("workspace-review-file-position")).toHaveTextContent("2/3")
    fireEvent.click(screen.getByTestId("workspace-review-prev-file"))
    expect(onSelect).toHaveBeenLastCalledWith({ path: "a.ts", staged: false })
    fireEvent.click(screen.getByTestId("workspace-review-next-file"))
    expect(onSelect).toHaveBeenLastCalledWith({ path: "c.ts", staged: false })
  })

  it("disables the ends of the list", () => {
    renderReview({ selected: { path: "a.ts", staged: false } })
    expect(screen.getByTestId("workspace-review-prev-file")).toBeDisabled()
    expect(screen.getByTestId("workspace-review-next-file")).not.toBeDisabled()
  })

  it("walks staged and unstaged entries of one path separately", () => {
    const { onSelect } = renderReview({
      status: status(["a.ts"], ["a.ts"]),
      selected: { path: "a.ts", staged: true },
    })
    fireEvent.click(screen.getByTestId("workspace-review-next-file"))
    expect(onSelect).toHaveBeenLastCalledWith({ path: "a.ts", staged: false })
  })

  it("steps with Alt+Arrow keys, but not while typing", () => {
    const { onSelect } = renderReview({ selected: { path: "b.ts", staged: false } })
    const root = screen.getByTestId("workspace-review")
    fireEvent.keyDown(root, { key: "ArrowDown", altKey: true })
    expect(onSelect).toHaveBeenLastCalledWith({ path: "c.ts", staged: false })
    fireEvent.keyDown(root, { key: "ArrowUp", altKey: true })
    expect(onSelect).toHaveBeenLastCalledWith({ path: "a.ts", staged: false })
    onSelect.mockClear()
    fireEvent.keyDown(screen.getByTestId("comment-box"), { key: "ArrowDown", altKey: true })
    fireEvent.keyDown(root, { key: "ArrowDown" })
    fireEvent.keyDown(root, { key: "ArrowDown", altKey: true, shiftKey: true })
    expect(onSelect).not.toHaveBeenCalled()
  })

  it("hands over to the next file when the reviewed one leaves the list", () => {
    const onSelect = jest.fn()
    const view = (s: GitStatus, selected = { path: "b.ts", staged: false }) => (
      <WorkspaceReview
        rootPath="/repo"
        status={s}
        actions={actions}
        committing={false}
        selected={selected}
        onSelect={onSelect}
        layout="desktop"
      />
    )
    const { rerender } = render(view(status(["a.ts", "b.ts", "c.ts"])))
    act(() => rerender(view(status(["a.ts", "c.ts"]))))
    // c.ts took b.ts's place.
    expect(onSelect).toHaveBeenLastCalledWith({ path: "c.ts", staged: false })
  })

  it("clears the selection when the last file leaves", () => {
    const onSelect = jest.fn()
    const view = (s: GitStatus) => (
      <WorkspaceReview
        rootPath="/repo"
        status={s}
        actions={actions}
        committing={false}
        selected={{ path: "a.ts", staged: false }}
        onSelect={onSelect}
        layout="desktop"
      />
    )
    const { rerender } = render(view(status(["a.ts"])))
    act(() => rerender(view(status([]))))
    expect(onSelect).toHaveBeenLastCalledWith(null)
  })

  it("does not jump from the stacked list when a file leaves", () => {
    mockWidth = 400
    const onSelect = jest.fn()
    const view = (s: GitStatus) => (
      <WorkspaceReview
        rootPath="/repo"
        status={s}
        actions={actions}
        committing={false}
        selected={{ path: "b.ts", staged: false }}
        onSelect={onSelect}
        layout="desktop"
      />
    )
    const { rerender } = render(view(status(["a.ts", "b.ts"])))
    act(() => rerender(view(status(["a.ts"]))))
    expect(onSelect).not.toHaveBeenCalled()
  })
})

describe("WorkspaceReview commit", () => {
  it("puts a compact commit box under the list, sized for the device", () => {
    mockWidth = 1000
    const { rerender } = renderReview({
      status: status(["a.ts"], ["s.ts"]),
      selected: { path: "a.ts", staged: false },
    })
    const box = screen.getByTestId("commit-box")
    expect(box).toHaveAttribute("data-staged", "1")
    expect(box).toHaveAttribute("data-compact", "true")
    expect(box).toHaveAttribute("data-density", "compact")
    rerender(
      <WorkspaceReview
        rootPath="/repo"
        status={status(["a.ts"], ["s.ts"])}
        actions={actions}
        committing={false}
        selected={null}
        onSelect={jest.fn()}
        layout="mobile"
      />
    )
    expect(screen.getByTestId("commit-box")).toHaveAttribute("data-density", "touch")
  })

  it("keeps the commit box off the stacked diff pane", () => {
    mockWidth = 400
    renderReview({
      selected: { path: "a.ts", staged: false },
      focus: { id: "r", file: { path: "a.ts", staged: false } },
    })
    expect(screen.getByTestId("diff")).toBeInTheDocument()
    expect(screen.queryByTestId("commit-box")).toBeNull()
  })
})

describe("WorkspaceReview conversation scope", () => {
  beforeEach(() => {
    mockWidth = 1000
  })

  it("offers no conversation scope without a conversation", () => {
    renderReview({ selected: { path: "a.ts", staged: false } })
    expect(screen.getByTestId("scope-picker")).toHaveAttribute("data-conversation", "false")
    expect(JSON.parse(screen.getByTestId("scope-picker").getAttribute("data-counts")!)).toEqual({
      uncommitted: 3,
      unstaged: 3,
      staged: 0,
    })
  })

  it("narrows the list to what this conversation changed, with counts and the baseline note", () => {
    mockConversationPaths = new Set(["b.ts"])
    renderReview({ sessionId: "s1", selected: { path: "b.ts", staged: false } })
    expect(
      JSON.parse(screen.getByTestId("scope-picker").getAttribute("data-counts")!)
    ).toMatchObject({ uncommitted: 3, conversation: 1 })
    expect(screen.getByTestId("changes")).toHaveAttribute("data-paths", "a.ts,b.ts,c.ts")
    fireEvent.click(screen.getByTestId("pick-conversation"))
    expect(screen.getByTestId("changes")).toHaveAttribute("data-paths", "b.ts")
    expect(screen.getByTestId("workspace-review-scope-note")).toBeInTheDocument()
    // File navigation walks the narrowed list.
    expect(screen.getByTestId("workspace-review-file-position")).toHaveTextContent("1/1")
  })

  it("says when the conversation changed nothing here, or is still being looked up", () => {
    mockConversationReady = false
    const { rerender } = renderReview({
      sessionId: "s1",
      selected: { path: "a.ts", staged: false },
    })
    fireEvent.click(screen.getByTestId("pick-conversation"))
    expect(screen.getByTestId("workspace-review-scope-empty")).toHaveTextContent(
      "Looking up what this conversation changed"
    )
    mockConversationReady = true
    rerender(
      <WorkspaceReview
        rootPath="/repo"
        sessionId="s1"
        status={status(["a.ts", "b.ts", "c.ts"])}
        actions={actions}
        committing={false}
        selected={{ path: "a.ts", staged: false }}
        onSelect={jest.fn()}
        layout="desktop"
      />
    )
    expect(screen.getByTestId("workspace-review-scope-empty")).toHaveTextContent(
      "hasn't changed any files"
    )
  })

  it("warns that the commit includes staged files the narrowed list hides", () => {
    mockConversationPaths = new Set(["a.ts"])
    renderReview({
      sessionId: "s1",
      status: status(["a.ts"], ["other.ts", "more.ts"]),
      selected: { path: "a.ts", staged: false },
    })
    expect(screen.queryByTestId("workspace-review-commit-hidden")).toBeNull()
    fireEvent.click(screen.getByTestId("pick-conversation"))
    expect(screen.getByTestId("workspace-review-commit-hidden")).toHaveTextContent("2 staged files")
    expect(screen.getByTestId("commit-box")).toHaveAttribute("data-staged", "2")
  })

  it("widens the list when a reveal names a file the narrowed list hides", () => {
    mockConversationPaths = new Set(["b.ts"])
    const onSelect = jest.fn()
    const view = (focus: { id: string; file: { path: string; staged: boolean } } | null) => (
      <WorkspaceReview
        rootPath="/repo"
        sessionId="s1"
        status={status(["a.ts", "b.ts", "c.ts"])}
        actions={actions}
        committing={false}
        selected={focus?.file ?? { path: "b.ts", staged: false }}
        onSelect={onSelect}
        layout="desktop"
        focus={focus}
      />
    )
    const { rerender } = render(view(null))
    fireEvent.click(screen.getByTestId("pick-conversation"))
    expect(screen.getByTestId("changes")).toHaveAttribute("data-paths", "b.ts")
    rerender(view({ id: "r1", file: { path: "c.ts", staged: false } }))
    expect(screen.getByTestId("changes")).toHaveAttribute("data-paths", "a.ts,b.ts,c.ts")
  })
})

describe("WorkspaceReview scopes", () => {
  beforeEach(() => {
    mockWidth = 1000
    mockConversationPaths = new Set()
    mockConversationReady = true
  })

  it("narrows to the staged or the unstaged side of the working tree", () => {
    renderReview({
      sessionId: "s1",
      status: status(["a.ts"], ["s.ts"]),
      selected: { path: "a.ts", staged: false },
    })
    expect(screen.getByTestId("changes")).toHaveAttribute("data-paths", "s.ts,a.ts")
    fireEvent.click(screen.getByTestId("pick-staged"))
    expect(screen.getByTestId("changes")).toHaveAttribute("data-paths", "s.ts")
    fireEvent.click(screen.getByTestId("pick-unstaged"))
    expect(screen.getByTestId("changes")).toHaveAttribute("data-paths", "a.ts")
    // The commit still takes the staged file the unstaged list hides.
    expect(screen.getByTestId("workspace-review-commit-hidden")).toBeInTheDocument()
  })

  it("says so when a working-tree half is empty", () => {
    renderReview({ sessionId: "s1", selected: { path: "a.ts", staged: false } })
    fireEvent.click(screen.getByTestId("pick-staged"))
    expect(screen.getByTestId("workspace-review-scope-empty")).toHaveTextContent(
      "Nothing is staged."
    )
  })

  it("hands a turn, commit or branch to the read-only snapshot review", () => {
    renderReview({ sessionId: "s1", selected: { path: "a.ts", staged: false } })
    fireEvent.click(screen.getByTestId("pick-turn"))
    expect(screen.getByTestId("snapshot-review")).toHaveAttribute(
      "data-selection",
      JSON.stringify({ scope: "lastTurn", runId: "run:1" })
    )
    expect(screen.queryByTestId("changes")).toBeNull()
    // The picker rides along as the snapshot's header, so the way back is there.
    fireEvent.click(screen.getByTestId("pick-uncommitted"))
    expect(screen.getByTestId("changes")).toBeInTheDocument()
  })

  it("opens on a revealed scope and file, and follows each new reveal", () => {
    const view = (scopeRequest: Parameters<typeof WorkspaceReview>[0]["scopeRequest"]) => (
      <WorkspaceReview
        rootPath="/repo"
        sessionId="s1"
        status={status(["a.ts", "b.ts"])}
        actions={actions}
        committing={false}
        selected={{ path: "a.ts", staged: false }}
        onSelect={jest.fn()}
        layout="desktop"
        scopeRequest={scopeRequest}
      />
    )
    const { rerender } = render(
      view({ id: "r1", choice: { scope: "lastTurn", runId: "run:7" }, relPath: "b.ts" })
    )
    expect(screen.getByTestId("snapshot-review")).toHaveAttribute("data-focus", "b.ts")
    rerender(view({ id: "r2", choice: { scope: "staged" } }))
    expect(screen.queryByTestId("snapshot-review")).toBeNull()
    expect(screen.getByTestId("scope-picker")).toHaveAttribute(
      "data-value",
      JSON.stringify({ scope: "staged" })
    )
  })

  it("lets a file reveal that also names a scope keep that scope", () => {
    const view = (id: string | null) => (
      <WorkspaceReview
        rootPath="/repo"
        sessionId="s1"
        status={status(["a.ts"], ["s.ts"])}
        actions={actions}
        committing={false}
        selected={{ path: "s.ts", staged: true }}
        onSelect={jest.fn()}
        layout="desktop"
        focus={id ? { id, file: { path: "s.ts", staged: true } } : null}
        scopeRequest={id ? { id, choice: { scope: "staged" }, relPath: "s.ts" } : null}
      />
    )
    const { rerender } = render(view(null))
    rerender(view("r1"))
    expect(screen.getByTestId("scope-picker")).toHaveAttribute(
      "data-value",
      JSON.stringify({ scope: "staged" })
    )
  })
})

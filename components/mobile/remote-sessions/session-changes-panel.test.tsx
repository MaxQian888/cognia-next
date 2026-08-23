import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { SessionChangesPanel } from "./session-changes-panel"
import type { SessionChangesState } from "./use-session-changes"
import type { RunChangeFile, RunChangeSet } from "@/lib/task-workspace/run-changes"

const state = jest.fn()
jest.mock("./use-session-changes", () => ({
  useSessionChanges: (...args: unknown[]) => state(...args),
}))

const diffBlock = jest.fn()
jest.mock("@/components/chat/renderers/diff-block", () => ({
  DiffBlock: (props: { content: string; filename?: string }) => {
    diffBlock(props)
    return <pre data-testid="diff-block">{props.content}</pre>
  },
}))

function file(over: Partial<RunChangeFile> = {}): RunChangeFile {
  return {
    path: "src/a.ts",
    kind: "modified",
    hunkCount: 1,
    availability: "available",
    stats: { additions: 3, deletions: 1 },
    ...over,
  }
}

function changeSet(files: RunChangeFile[], withheld = 0, runId = "run:1"): RunChangeSet {
  return {
    runId,
    files,
    totals: { files: files.length, additions: 3, deletions: 1, withheld },
  }
}

const loadDiff = jest.fn()
const selectRun = jest.fn()

function setState(over: Partial<SessionChangesState> = {}) {
  state.mockReturnValue({
    loading: false,
    untracked: false,
    runs: [{ runId: "run:1", createdAt: 10, state: "ready" as const }],
    selectedRunId: "run:1",
    selectRun,
    changes: changeSet([file()]),
    diffs: {},
    loadDiff,
    ...over,
  })
}

beforeEach(() => {
  jest.clearAllMocks()
  setState()
})

describe("SessionChangesPanel", () => {
  it("shows a loading line while the host is being asked", () => {
    setState({ loading: true, changes: undefined })
    render(<SessionChangesPanel sessionId="s1" />)
    expect(screen.getByText("Loading changes…")).toBeInTheDocument()
  })

  it("reports a failure rather than an empty change list", () => {
    setState({ error: "not paired", changes: undefined })
    render(<SessionChangesPanel sessionId="s1" />)
    expect(screen.getByTestId("session-changes-error")).toHaveTextContent("not paired")
    expect(screen.queryByTestId("session-changes-empty")).not.toBeInTheDocument()
  })

  it("says the session was never tracked, which is not the same as unchanged", () => {
    setState({ untracked: true, changes: undefined, runs: [] })
    render(<SessionChangesPanel sessionId="s1" />)
    expect(screen.getByTestId("session-changes-untracked")).toBeInTheDocument()
    expect(screen.queryByTestId("session-changes-empty")).not.toBeInTheDocument()
  })

  it("says a running turn has not recorded its changes yet", () => {
    setState({
      changes: undefined,
      runs: [{ runId: "run:1", createdAt: 10, state: "running" }],
    })
    render(<SessionChangesPanel sessionId="s1" />)
    expect(screen.getByTestId("session-changes-pending")).toBeInTheDocument()
    expect(screen.queryByTestId("session-changes-empty")).not.toBeInTheDocument()
  })

  it("says a settled turn changed nothing", () => {
    setState({ changes: undefined })
    render(<SessionChangesPanel sessionId="s1" />)
    expect(screen.getByTestId("session-changes-empty")).toBeInTheDocument()
  })

  it("lists files with their kind and line counts", () => {
    render(<SessionChangesPanel sessionId="s1" />)
    const list = screen.getByTestId("session-changes-list")
    expect(within(list).getByText("src/a.ts")).toBeInTheDocument()
    expect(within(list).getByText("Modified")).toBeInTheDocument()
    expect(within(list).getByText("+3")).toBeInTheDocument()
    expect(within(list).getByText("−1")).toBeInTheDocument()
    expect(screen.getByTestId("session-changes-totals")).toHaveTextContent("+3")
  })

  it("omits line counts for a file the ledger kept none for", () => {
    setState({
      changes: changeSet([
        file({ path: "src/new.ts", kind: "created", hunkCount: 0, availability: "noTextDiff", stats: undefined }),
      ], 1),
    })
    render(<SessionChangesPanel sessionId="s1" />)
    const list = screen.getByTestId("session-changes-list")
    expect(within(list).getByText("Added")).toBeInTheDocument()
    // No "+0 −0", which would claim an added file added nothing.
    expect(within(list).queryByText("+0")).not.toBeInTheDocument()
    expect(screen.getByTestId("session-changes-withheld")).toBeInTheDocument()
  })

  it("loads a body only when a file is opened", async () => {
    const user = userEvent.setup()
    render(<SessionChangesPanel sessionId="s1" />)
    expect(loadDiff).not.toHaveBeenCalled()
    await user.click(screen.getByRole("button", { name: /Show the diff for src\/a\.ts/ }))
    expect(loadDiff).toHaveBeenCalledWith("src/a.ts")
  })

  it("renders a loaded body through the pure-DOM diff renderer", async () => {
    setState({ diffs: { "src/a.ts": { status: "loaded", text: "@@ -1 +1 @@\n-a\n+b" } } })
    const user = userEvent.setup()
    render(<SessionChangesPanel sessionId="s1" />)
    await user.click(screen.getByRole("button", { name: /Show the diff/ }))
    expect(screen.getByTestId("diff-block")).toHaveTextContent("-a")
    expect(diffBlock).toHaveBeenCalledWith(expect.objectContaining({ filename: "src/a.ts" }))
  })

  it("explains a withheld sensitive file and never asks for its body", async () => {
    setState({ changes: changeSet([file({ path: "app/.env", availability: "sensitive" })], 1) })
    const user = userEvent.setup()
    render(<SessionChangesPanel sessionId="s1" />)
    await user.click(screen.getByRole("button", { name: /Show the diff/ }))
    expect(screen.getByTestId("session-changes-unavailable-sensitive")).toHaveTextContent(
      "credentials"
    )
    expect(loadDiff).not.toHaveBeenCalled()
    expect(screen.queryByTestId("diff-block")).not.toBeInTheDocument()
  })

  it.each([
    ["binary", "Binary file"],
    ["symlink", "Symbolic link"],
    ["noTextDiff", "no line diff"],
  ] as const)("explains a %s file instead of showing an empty pane", async (availability, text) => {
    setState({ changes: changeSet([file({ availability, stats: undefined })], 1) })
    const user = userEvent.setup()
    render(<SessionChangesPanel sessionId="s1" />)
    await user.click(screen.getByRole("button", { name: /Show the diff/ }))
    expect(screen.getByTestId(`session-changes-unavailable-${availability}`)).toHaveTextContent(text)
    expect(loadDiff).not.toHaveBeenCalled()
  })

  it("says the host returned no body rather than rendering a blank diff", async () => {
    setState({ diffs: { "src/a.ts": { status: "empty" } } })
    const user = userEvent.setup()
    render(<SessionChangesPanel sessionId="s1" />)
    await user.click(screen.getByRole("button", { name: /Show the diff/ }))
    expect(screen.getByTestId("session-changes-diff-empty")).toBeInTheDocument()
    expect(screen.queryByTestId("diff-block")).not.toBeInTheDocument()
  })

  it("surfaces a body failure with its reason", async () => {
    setState({ diffs: { "src/a.ts": { status: "error", message: "forbidden" } } })
    const user = userEvent.setup()
    render(<SessionChangesPanel sessionId="s1" />)
    await user.click(screen.getByRole("button", { name: /Show the diff/ }))
    expect(screen.getByText(/forbidden/)).toBeInTheDocument()
  })

  it("hides the turn selector for a single turn and offers it for several", async () => {
    render(<SessionChangesPanel sessionId="s1" />)
    expect(screen.queryByTestId("session-changes-run")).not.toBeInTheDocument()

    setState({
      runs: [
        { runId: "run:2", createdAt: 20, state: "ready" },
        { runId: "run:1", createdAt: 10, state: "ready" },
      ],
      selectedRunId: "run:2",
    })
    const user = userEvent.setup()
    render(<SessionChangesPanel sessionId="s1" />)
    const select = screen.getByTestId("session-changes-run")
    // Newest first in the list, so the oldest turn is numbered 1.
    expect(within(select).getByRole("option", { name: /Turn 2/ })).toBeInTheDocument()
    await user.selectOptions(select, "run:1")
    expect(selectRun).toHaveBeenCalledWith("run:1")
  })

  it("collapses open rows when another turn is selected", async () => {
    // Two turns routinely touch the same path; a row left open would show the
    // previous turn's body under the new turn's file.
    setState({ diffs: { "src/a.ts": { status: "loaded", text: "@@ old @@" } } })
    const user = userEvent.setup()
    const { rerender } = render(<SessionChangesPanel sessionId="s1" />)
    await user.click(screen.getByRole("button", { name: /Show the diff/ }))
    expect(screen.getByTestId("diff-block")).toBeInTheDocument()

    setState({
      changes: changeSet([file()], 0, "run:2"),
      diffs: { "src/a.ts": { status: "loaded", text: "@@ old @@" } },
    })
    rerender(<SessionChangesPanel sessionId="s1" />)
    expect(screen.queryByTestId("diff-block")).not.toBeInTheDocument()
  })

  it("shows the rename origin so a moved file is not read as a new one", () => {
    setState({
      changes: changeSet([file({ path: "b.ts", kind: "renamed", oldPath: "a.ts" })]),
    })
    render(<SessionChangesPanel sessionId="s1" />)
    expect(screen.getByText("Renamed from a.ts")).toBeInTheDocument()
  })
})

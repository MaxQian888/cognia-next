/**
 * @jest-environment jsdom
 */

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"

import type { CodeAdoptionTurnRow } from "@/lib/code-adoption/types"

import { TURN_CHANGES_PREVIEW, TurnChangesCard, turnPatchRunId } from "./turn-changes-card"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${JSON.stringify(values)}` : key,
}))

const toastSuccess = jest.fn()
const toastError = jest.fn()
jest.mock("sonner", () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccess(...args),
    error: (...args: unknown[]) => toastError(...args),
  },
}))

// The confirm dialog renders inline so its action is reachable without Radix.
jest.mock("@/components/ui/alert-dialog", () => ({
  AlertDialog: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
    open ? <div role="alertdialog">{children}</div> : null,
  AlertDialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
  AlertDialogDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
  AlertDialogCancel: ({ children }: { children: React.ReactNode }) => <button>{children}</button>,
  AlertDialogAction: ({
    children,
    onClick,
    ...rest
  }: {
    children: React.ReactNode
    onClick: () => void
    "data-testid"?: string
  }) => (
    <button data-testid={rest["data-testid"]} onClick={onClick}>
      {children}
    </button>
  ),
}))

let mockRow: CodeAdoptionTurnRow | null = null
jest.mock("@/hooks/chat/use-turn-changes", () => ({
  useTurnChanges: () => mockRow,
}))
jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: () => ({ id: "s1", projectId: "p1" }),
}))
jest.mock("@/lib/db/sessions", () => ({ getSession: jest.fn() }))
jest.mock("@/lib/workspace/session-root", () => ({
  sessionExecutionRootPath: () => "/exec-root",
}))
jest.mock("@/stores/project/project-store", () => ({
  useProjectStore: (selector: (state: { projects: unknown[] }) => unknown) =>
    selector({ projects: [] }),
}))

const getTaskPatchSet = jest.fn()
const undoTaskWorkspace = jest.fn()
jest.mock("@/lib/task-workspace/client", () => ({
  getTaskPatchSet: (...args: unknown[]) => getTaskPatchSet(...args),
  undoTaskWorkspace: (...args: unknown[]) => undoTaskWorkspace(...args),
}))

const revealWorkspaceReview = jest.fn()
jest.mock("@/stores/artifact/artifact-dock-layout-store", () => ({
  useArtifactDockLayoutStore: { getState: () => ({ revealWorkspaceReview }) },
}))

function row(over: Partial<CodeAdoptionTurnRow> = {}): CodeAdoptionTurnRow {
  return {
    id: "s1:1:e",
    runId: 1,
    sessionId: "s1",
    taskWorkspaceRunId: "run:s1:1",
    workspaceRoot: "/repo",
    agentKind: "in-app",
    model: null,
    ts: 1,
    totalFiles: 2,
    totalAdded: 67,
    totalRemoved: 1,
    files: [
      {
        path: "packages/web/src/hooks/use-spaces.test.tsx",
        added: 65,
        removed: 0,
        isNew: true,
        hunks: [],
      },
      { path: "README.md", added: 2, removed: 1, isNew: false, hunks: [] },
    ],
    truncated: false,
    measurement: "taskWorkspace",
    trackingState: "tracked",
    adoptionState: "pending",
    ...over,
  }
}

const applied = { state: "applied", reversible: true }

beforeEach(() => {
  mockRow = row()
  getTaskPatchSet.mockReset().mockResolvedValue(applied)
  undoTaskWorkspace.mockReset()
  revealWorkspaceReview.mockReset()
  toastSuccess.mockReset()
  toastError.mockReset()
})

async function renderCard() {
  render(<TurnChangesCard sessionId="s1" messageId="m1" />)
  await act(async () => {})
}

describe("turnPatchRunId", () => {
  it("names the run only for a Task Workspace measured turn", () => {
    expect(turnPatchRunId(row())).toBe("run:s1:1")
    expect(turnPatchRunId(row({ measurement: "legacyFingerprint" }))).toBeNull()
    expect(turnPatchRunId(row({ taskWorkspaceRunId: undefined }))).toBeNull()
  })
})

describe("TurnChangesCard", () => {
  it("renders nothing without a record, for an empty turn, or an untracked one", async () => {
    mockRow = null
    const { rerender, container } = render(<TurnChangesCard sessionId="s1" messageId="m1" />)
    expect(container).toBeEmptyDOMElement()
    mockRow = row({ totalFiles: 0, files: [] })
    rerender(<TurnChangesCard sessionId="s1" messageId="m1" />)
    expect(container).toBeEmptyDOMElement()
    mockRow = row({ trackingState: "unavailable" })
    rerender(<TurnChangesCard sessionId="s1" messageId="m1" />)
    expect(container).toBeEmptyDOMElement()
  })

  it("shows the totals and every file with its own counts", async () => {
    await renderCard()
    expect(screen.getByTestId("turn-changes-title")).toHaveTextContent('edited:{"count":2}')
    expect(screen.getByTestId("turn-changes-total")).toHaveTextContent("+67 −1")
    expect(screen.getByTestId("turn-changes-file-README.md")).toHaveTextContent("+2 −1")
    expect(
      screen.getByTestId("turn-changes-file-packages/web/src/hooks/use-spaces.test.tsx")
    ).toHaveTextContent("packages/web/src/hooks/use-spaces.test.tsx")
  })

  it("opens the dock on this turn's diff, and on one file from its row", async () => {
    await renderCard()
    fireEvent.click(screen.getByTestId("turn-changes-view"))
    expect(revealWorkspaceReview).toHaveBeenCalledWith({
      sessionId: "s1",
      rootPath: "/exec-root",
      scope: { scope: "lastTurn", runId: "run:s1:1" },
    })
    fireEvent.click(screen.getByTestId("turn-changes-file-README.md"))
    expect(revealWorkspaceReview).toHaveBeenLastCalledWith({
      sessionId: "s1",
      rootPath: "/exec-root",
      scope: { scope: "lastTurn", runId: "run:s1:1" },
      relPath: "README.md",
    })
  })

  it("opens a fingerprinted turn on the working tree and offers no undo", async () => {
    mockRow = row({ measurement: "legacyFingerprint" })
    await renderCard()
    expect(getTaskPatchSet).not.toHaveBeenCalled()
    expect(screen.queryByTestId("turn-changes-undo")).toBeNull()
    fireEvent.click(screen.getByTestId("turn-changes-view"))
    expect(revealWorkspaceReview).toHaveBeenCalledWith(
      expect.objectContaining({ scope: { scope: "uncommitted" } })
    )
  })

  it.each([
    ["ready", true],
    ["reverted", true],
    ["applied", false],
  ])(
    "hides undo for a %s patch (reversible=%s) unless applied and reversible",
    async (state, reversible) => {
      getTaskPatchSet.mockResolvedValue({ state, reversible })
      await renderCard()
      expect(screen.queryByTestId("turn-changes-undo")).toBeNull()
    }
  )

  it("undoes the turn after confirmation and reports success", async () => {
    undoTaskWorkspace.mockResolvedValue({ state: "reverted", revision: 2, conflicts: [] })
    await renderCard()
    fireEvent.click(screen.getByTestId("turn-changes-undo"))
    await act(async () => {
      fireEvent.click(screen.getByTestId("turn-changes-undo-confirm"))
    })
    expect(undoTaskWorkspace).toHaveBeenCalledWith("run:s1:1")
    expect(toastSuccess).toHaveBeenCalledWith('undoSuccess:{"count":2}')
    // The patch is re-read so the button follows the new state.
    await waitFor(() => expect(getTaskPatchSet).toHaveBeenCalledTimes(2))
  })

  it("reports a conflicted undo instead of claiming success", async () => {
    undoTaskWorkspace.mockResolvedValue({
      state: "conflict",
      revision: 2,
      conflicts: [{ path: "README.md", reason: "changed" }],
    })
    await renderCard()
    fireEvent.click(screen.getByTestId("turn-changes-undo"))
    await act(async () => {
      fireEvent.click(screen.getByTestId("turn-changes-undo-confirm"))
    })
    expect(toastError).toHaveBeenCalledWith('undoConflict:{"count":1}')
    expect(toastSuccess).not.toHaveBeenCalled()
  })

  it("says there is nothing to undo when the patch turns out not to be applied", async () => {
    undoTaskWorkspace.mockResolvedValue({ state: "ready", revision: 2, conflicts: [] })
    await renderCard()
    fireEvent.click(screen.getByTestId("turn-changes-undo"))
    await act(async () => {
      fireEvent.click(screen.getByTestId("turn-changes-undo-confirm"))
    })
    expect(toastError).toHaveBeenCalledWith("undoNotApplied")
  })

  it("reports a failed undo", async () => {
    undoTaskWorkspace.mockRejectedValue(new Error("boom"))
    await renderCard()
    fireEvent.click(screen.getByTestId("turn-changes-undo"))
    await act(async () => {
      fireEvent.click(screen.getByTestId("turn-changes-undo-confirm"))
    })
    expect(toastError).toHaveBeenCalledWith('undoFailed:{"error":"boom"}')
  })

  it("says the turn was reverted once it has been", async () => {
    mockRow = row({ adoptionState: "reverted" })
    await renderCard()
    expect(screen.getByTestId("turn-changes-title")).toHaveTextContent('reverted:{"count":2}')
    expect(screen.queryByTestId("turn-changes-undo")).toBeNull()
  })

  it("lists the first files and expands to all of them", async () => {
    const files = Array.from({ length: TURN_CHANGES_PREVIEW + 3 }, (_, i) => ({
      path: `f${i}.ts`,
      added: 1,
      removed: 0,
      isNew: false,
      hunks: [] as Array<[number, number]>,
    }))
    mockRow = row({ files, totalFiles: files.length, truncated: true })
    await renderCard()
    expect(screen.getAllByTestId(/^turn-changes-file-/)).toHaveLength(TURN_CHANGES_PREVIEW)
    expect(screen.getByTestId("turn-changes-truncated")).toBeInTheDocument()
    fireEvent.click(screen.getByTestId("turn-changes-show-all"))
    expect(screen.getAllByTestId(/^turn-changes-file-/)).toHaveLength(files.length)
  })
})

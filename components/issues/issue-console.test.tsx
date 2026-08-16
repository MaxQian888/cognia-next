/**
 * @jest-environment jsdom
 */

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${Object.values(vars).join(",")}` : key,
}))

jest.mock("@/components/feature-shell/feature-page-shell", () => ({
  FeaturePageShell: ({
    header,
    children,
    rightPane,
  }: {
    header: React.ReactNode
    children: React.ReactNode
    rightPane?: { content: React.ReactNode }
  }) => (
    <div>
      {header}
      {children}
      {rightPane?.content}
    </div>
  ),
}))
jest.mock("@/components/feature-shell/feature-page-header", () => ({
  FeaturePageHeader: ({ controls }: { controls?: React.ReactNode }) => <div>{controls}</div>,
}))

// Board / list / inspector / dialog are covered by their own suites; stub them
// so this one stays at the orchestration layer.
let boardProps: Record<string, unknown> = {}
jest.mock("./board/issue-board", () => ({
  IssueBoard: (props: Record<string, unknown>) => {
    boardProps = props
    return <div data-testid="board-stub" />
  },
}))
jest.mock("./issue-list", () => ({ IssueList: () => <div data-testid="list-stub" /> }))
let detailProps: Record<string, unknown> = {}
jest.mock("./issue-detail-panel", () => ({
  IssueDetailPanel: (props: Record<string, unknown>) => {
    detailProps = props
    return <div data-testid="detail-stub" />
  },
}))
jest.mock("./create-issue-dialog", () => ({
  CreateIssueDialog: (props: Record<string, unknown>) =>
    props.open ? <div data-testid="create-dialog-stub" /> : null,
}))
jest.mock("./board/board-toolbar", () => ({
  IssueBoardToolbar: (props: { onLayoutChange: (l: string) => void }) => (
    <button data-testid="toolbar-to-list" onClick={() => props.onLayoutChange("list")} />
  ),
}))

const mockMoveIssue = jest.fn().mockResolvedValue(null)
const mockReorderIssues = jest.fn().mockResolvedValue(undefined)
jest.mock("@/lib/db/issues", () => ({
  listIssues: jest.fn(),
  moveIssue: (...a: unknown[]) => mockMoveIssue(...a),
  reorderIssues: (...a: unknown[]) => mockReorderIssues(...a),
}))
jest.mock("@/lib/db/issue-projects", () => ({ listIssueProjects: jest.fn() }))
jest.mock("@/lib/db/labels", () => ({ listLabels: jest.fn() }))
// Stable reference on purpose: a fresh array per render would mask whether
// the console's fan-out effect is identity-fragile.
const EMPTY_ROWS: unknown[] = []
jest.mock("@/hooks/data", () => ({ useClientLiveQuery: () => EMPTY_ROWS }))

const mockListAll = jest.fn()
jest.mock("@/lib/issues/sources/registry", () => ({
  getIssueSourceRegistry: () => ({ listAll: (...a: unknown[]) => mockListAll(...a) }),
}))

const mockRunSync = jest.fn()
jest.mock("@/lib/issues/sync-runner", () => ({
  runWorkspaceGithubSync: (...a: unknown[]) => mockRunSync(...a),
}))

const mockToastError = jest.fn()
jest.mock("sonner", () => ({ toast: { error: (...a: unknown[]) => mockToastError(...a) } }))

let activeProjectId: string | null = "w1"
jest.mock("@/stores/project/project-store", () => ({
  useProjectStore: (selector: (s: { activeProjectId: string | null }) => unknown) =>
    selector({ activeProjectId }),
}))

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { statusCategoryOf } from "@/types/issues"
import type { UnifiedIssueItem } from "@/types/issues/unified"
import { FULL_ISSUE_CAPABILITIES, READ_ONLY_ISSUE_CAPABILITIES } from "@/types/issues/unified"
import { IssueConsole } from "./issue-console"

function item(over: Partial<UnifiedIssueItem> = {}): UnifiedIssueItem {
  const kind = over.kind ?? "local"
  return {
    unifiedId: `${kind}:i1`,
    kind,
    sourceId: "i1",
    identifier: "MERC-1",
    title: "Ship it",
    status: "todo",
    statusCategory: statusCategoryOf("todo"),
    priority: "none",
    labelIds: [],
    order: 0,
    createdAt: 1,
    updatedAt: 1,
    origin: { deepLinkHref: "/issues" },
    capabilities: kind === "local" ? FULL_ISSUE_CAPABILITIES : READ_ONLY_ISSUE_CAPABILITIES,
    ...over,
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  boardProps = {}
  activeProjectId = "w1"
  mockListAll.mockResolvedValue({ items: [], errors: [] })
})

describe("IssueConsole", () => {
  it("reads the board through the source registry, not straight from Dexie", async () => {
    render(<IssueConsole />)
    await waitFor(() => expect(mockListAll).toHaveBeenCalledWith({ projectId: "w1" }))
  })

  it("does not query when no workspace is active", async () => {
    activeProjectId = null
    render(<IssueConsole />)
    await waitFor(() => expect(mockListAll).not.toHaveBeenCalled())
  })

  it("renders the four built-in views", async () => {
    render(<IssueConsole />)
    for (const id of ["all", "assigned", "created", "my-agents"]) {
      expect(await screen.findByTestId(`issue-view-${id}`)).toBeInTheDocument()
    }
  })

  it("switches layout when the view changes, and back when the toolbar overrides", async () => {
    mockListAll.mockResolvedValue({ items: [item()], errors: [] })
    render(<IssueConsole />)
    expect(await screen.findByTestId("board-stub")).toBeInTheDocument()

    // The `created` view ships a list layout.
    fireEvent.click(screen.getByTestId("issue-view-created"))
    expect(await screen.findByTestId("list-stub")).toBeInTheDocument()
  })

  it("lets the toolbar override the view's layout", async () => {
    render(<IssueConsole />)
    fireEvent.click(await screen.findByTestId("toolbar-to-list"))
    expect(await screen.findByTestId("list-stub")).toBeInTheDocument()
  })

  it("reports how many agents are working", async () => {
    render(<IssueConsole />)
    expect(await screen.findByTestId("issue-agents-working")).toHaveTextContent(
      "board.agentsWorking:0"
    )
  })

  it("surfaces a degraded source rather than under-reporting silently", async () => {
    mockListAll.mockResolvedValue({
      items: [],
      errors: [{ kind: "github", error: new Error("x") }],
    })
    render(<IssueConsole />)
    expect(await screen.findByTestId("issue-source-errors")).toBeInTheDocument()
  })

  it("hides the degraded badge when every source is healthy", async () => {
    render(<IssueConsole />)
    await screen.findByTestId("issue-agents-working")
    expect(screen.queryByTestId("issue-source-errors")).not.toBeInTheDocument()
  })

  it("opens the create dialog from the header", async () => {
    render(<IssueConsole />)
    expect(screen.queryByTestId("create-dialog-stub")).not.toBeInTheDocument()
    fireEvent.click(await screen.findByTestId("issue-create-trigger"))
    expect(await screen.findByTestId("create-dialog-stub")).toBeInTheDocument()
  })

  it("disables creation when no workspace is active", async () => {
    activeProjectId = null
    render(<IssueConsole />)
    expect(await screen.findByTestId("issue-create-trigger")).toBeDisabled()
  })

  it("writes a move through the guarded CRUD path", async () => {
    mockListAll.mockResolvedValue({ items: [item()], errors: [] })
    render(<IssueConsole />)
    await screen.findByTestId("board-stub")

    await (boardProps.onDrop as (a: unknown) => Promise<void>)({
      type: "move",
      unifiedId: "local:i1",
      to: "done",
    })
    expect(mockMoveIssue).toHaveBeenCalledWith({
      id: "i1",
      to: "done",
      by: { kind: "human" },
    })
  })

  it("localizes a denial instead of failing silently", async () => {
    mockListAll.mockResolvedValue({ items: [item({ kind: "github" })], errors: [] })
    render(<IssueConsole />)
    await screen.findByTestId("board-stub")

    await (boardProps.onDrop as (a: unknown) => Promise<void>)({
      type: "denied",
      unifiedId: "github:i1",
      reason: "federated-read-only",
    })
    expect(mockToastError).toHaveBeenCalledWith(
      expect.stringContaining("board.denied.federated-read-only")
    )
    expect(mockMoveIssue).not.toHaveBeenCalled()
  })

  it("never writes for a federated row even if a move slips through", async () => {
    mockListAll.mockResolvedValue({ items: [item({ kind: "github" })], errors: [] })
    render(<IssueConsole />)
    await screen.findByTestId("board-stub")

    await (boardProps.onDrop as (a: unknown) => Promise<void>)({
      type: "move",
      unifiedId: "github:i1",
      to: "done",
    })
    expect(mockMoveIssue).not.toHaveBeenCalled()
  })

  it("reports a denial returned by the write boundary itself", async () => {
    mockMoveIssue.mockResolvedValueOnce("runtime-owned")
    mockListAll.mockResolvedValue({ items: [item()], errors: [] })
    render(<IssueConsole />)
    await screen.findByTestId("board-stub")

    await (boardProps.onDrop as (a: unknown) => Promise<void>)({
      type: "move",
      unifiedId: "local:i1",
      to: "in_progress",
    })
    expect(mockToastError).toHaveBeenCalledWith(
      expect.stringContaining("board.denied.runtime-owned")
    )
  })

  it("persists a reorder", async () => {
    mockListAll.mockResolvedValue({
      items: [item(), item({ kind: "local", sourceId: "i2" })],
      errors: [],
    })
    render(<IssueConsole />)
    await screen.findByTestId("board-stub")

    await (boardProps.onDrop as (a: unknown) => Promise<void>)({
      type: "reorder",
      unifiedId: "local:i1",
      targetIndex: 1,
    })
    expect(mockReorderIssues).toHaveBeenCalled()
  })
})

describe("GitHub write-back refresh", () => {
  async function selectFederatedIssue() {
    mockListAll.mockResolvedValue({
      items: [item({ kind: "github", unifiedId: "github:o/r#7" })],
      errors: [],
    })
    render(<IssueConsole />)
    await waitFor(() => expect(mockListAll).toHaveBeenCalled())
    await waitFor(() => expect(boardProps.items).toHaveLength(1))
    act(() => {
      ;(boardProps.onSelect as (id: string) => void)("github:o/r#7")
    })
    await waitFor(() => expect(screen.getByTestId("detail-stub")).toBeInTheDocument())
  }

  it("round-trips through GitHub rather than patching the row locally", async () => {
    mockRunSync.mockResolvedValue({ repoCount: 1, results: [], failures: [] })
    await selectFederatedIssue()
    const before = mockListAll.mock.calls.length

    await act(async () => {
      await (detailProps.onWritebackCompleted as () => Promise<void>)()
    })

    // GitHub owns these rows; an optimistic local edit would be a second
    // source of truth for the same field.
    expect(mockRunSync).toHaveBeenCalledWith({ projectId: "w1", full: true })
    await waitFor(() => expect(mockListAll.mock.calls.length).toBeGreaterThan(before))
  })

  it("still re-reads the sources when the refetch itself fails", async () => {
    mockRunSync.mockRejectedValue(new Error("offline"))
    await selectFederatedIssue()
    const before = mockListAll.mock.calls.length

    await act(async () => {
      await (detailProps.onWritebackCompleted as () => Promise<void>)()
    })

    // The write DID land on GitHub; failing to re-read must not hide it forever.
    await waitFor(() => expect(mockListAll.mock.calls.length).toBeGreaterThan(before))
  })
})

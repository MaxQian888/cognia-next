/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react"

import type { WorkflowRow } from "@/types/workflow/visual"
import { ROOT_FOLDER_ID } from "@/types/workflow/folder"
import { DEFAULT_WORKFLOW_FILTERS, useWorkflowLibraryStore } from "@/stores/workflow"

import { WorkflowList } from "./workflow-list"

jest.mock("next/link", () => {
  const Link = ({ children, href, ...rest }: { children: React.ReactNode; href: string }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  )
  return { __esModule: true, default: Link }
})

// Ordered queue: each useLiveQuery call shifts the next value. Render order is
// childFolders → folderPath → folderWorkflows → recentlyFailed → runCounts →
// activeRuns → pendingTriggers.
const liveQueries: Array<unknown> = []
jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: (factory: () => unknown) => {
    void factory
    return liveQueries.shift()
  },
}))

jest.mock("@/lib/db/workflows", () => ({
  listWorkflowsInFolder: jest.fn(),
  getRecentlyFailedWorkflowIds: jest.fn(),
  getRunCounts: jest.fn(),
}))
jest.mock("@/lib/db/workflow-folders", () => ({
  listChildFolders: jest.fn(),
  getFolderPath: jest.fn(),
}))

jest.mock("@/lib/db/schema", () => ({
  getDb: () => ({
    workflowRuns: {
      where: () => ({ equals: () => ({ toArray: () => Promise.resolve([]) }) }),
    },
    mobileOutboundQueue: {
      where: () => ({ equals: () => ({ toArray: () => Promise.resolve([]) }) }),
    },
  }),
}))

jest.mock("@/lib/sync/companion-sync", () => ({ runSyncDown: jest.fn(async () => {}) }))
jest.mock("@/lib/db/mobile-outbound-queue", () => ({ enqueue: jest.fn(async () => {}) }))

// Heavy library children — stub to keep this focused on the list shell.
jest.mock("./workflow-list-toolbar", () => ({
  WorkflowListToolbar: ({ onNewWorkflow }: { onNewWorkflow: () => void }) => (
    <button type="button" data-testid="toolbar-new" onClick={onNewWorkflow}>
      new
    </button>
  ),
}))
jest.mock("@/components/workflow/library/workflow-create-dialog", () => ({
  WorkflowCreateDialog: ({ open }: { open: boolean }) =>
    open ? <div data-testid="create-dialog-open" /> : null,
}))
jest.mock("@/components/workflow/library/workflow-create-folder-dialog", () => ({
  WorkflowCreateFolderDialog: () => <div data-testid="create-folder-dialog" />,
}))
jest.mock("@/components/workflow/library/workflow-folder-breadcrumb", () => ({
  WorkflowFolderBreadcrumb: ({ path }: { path: unknown[] }) => (
    <div data-testid="breadcrumb-stub">{path.length}</div>
  ),
}))

const saveMock: jest.Mock<Promise<void>, [Record<string, unknown>]> = jest.fn()
const settingsRef: { value: { pinnedWorkflowIds?: string[] } | null } = {
  value: { pinnedWorkflowIds: [] },
}
jest.mock("@/stores/settings", () => ({
  useSettingsStore: (
    selector: (s: {
      settings: { pinnedWorkflowIds?: string[] } | null
      save: typeof saveMock
    }) => unknown
  ) => selector({ settings: settingsRef.value, save: saveMock }),
}))

jest.mock("./trigger-button", () => ({
  TriggerButton: ({ workflowId }: { workflowId: string }) => (
    <button type="button" data-testid={`trigger-${workflowId}`}>
      Run
    </button>
  ),
}))
jest.mock("./pinned-section", () => ({
  PinnedSection: ({ pinnedIds }: { pinnedIds: string[] }) =>
    pinnedIds.length > 0 ? <div data-testid="pinned-section-stub">{pinnedIds.length}</div> : null,
}))
jest.mock("./recent-runs-feed", () => ({
  RecentRunsFeed: () => <div data-testid="recent-runs-stub" />,
}))
jest.mock("@/components/interactions/long-press", () => ({
  LongPress: ({ children, onLongPress }: { children: React.ReactNode; onLongPress: () => void }) => (
    <span data-testid="long-press-stub" onContextMenu={() => onLongPress()}>
      {children}
    </span>
  ),
}))
jest.mock("@/components/mobile/empty-state", () => ({
  EmptyState: ({ title, spotIcon }: { title: string; spotIcon?: string }) => (
    <div data-testid="empty-state" data-spot-icon={spotIcon}>
      {title}
    </div>
  ),
}))
jest.mock("sonner", () => ({ toast: { success: jest.fn() } }))

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

const wf = (id: string, name = id, description?: string): WorkflowRow =>
  ({
    id,
    name,
    description,
    schemaVersion: 1,
    nodes: [],
    edges: [],
    settings: {},
    createdAt: 0,
    updatedAt: 0,
  }) as unknown as WorkflowRow

function pushQueries({
  folders = [] as unknown,
  path = [] as unknown,
  workflows = [] as unknown,
  runs = [] as unknown,
  triggers = [] as unknown,
} = {}) {
  liveQueries.push(
    folders,
    path,
    workflows,
    new Set<string>(),
    new Map<string, number>(),
    runs,
    triggers
  )
}

beforeEach(() => {
  liveQueries.length = 0
  saveMock.mockReset().mockResolvedValue(undefined)
  settingsRef.value = { pinnedWorkflowIds: [] }
  useWorkflowLibraryStore.setState({
    currentFolderId: ROOT_FOLDER_ID,
    query: "",
    sort: "updated",
    filters: DEFAULT_WORKFLOW_FILTERS,
  })
})

describe("<WorkflowList />", () => {
  it("renders the empty state when nothing exists", () => {
    pushQueries({})
    render(<WorkflowList />)
    expect(screen.getByTestId("empty-state")).toBeInTheDocument()
    expect(screen.getByTestId("empty-state")).toHaveAttribute("data-spot-icon", "workflows")
    expect(screen.queryByTestId("pinned-section-stub")).not.toBeInTheDocument()
  })

  it("renders rows + pinned + recent feed at the root", () => {
    pushQueries({ workflows: [wf("a", "Alpha", "Daily snap"), wf("b", "Beta")] })
    settingsRef.value = { pinnedWorkflowIds: ["a"] }
    render(<WorkflowList />)
    expect(screen.getByTestId("pinned-section-stub")).toHaveTextContent("1")
    expect(screen.getByTestId("workflow-row-a")).toBeInTheDocument()
    expect(screen.getByTestId("workflow-row-b")).toBeInTheDocument()
    expect(screen.getByTestId("workflow-pinned-a")).toBeInTheDocument()
    expect(screen.queryByTestId("workflow-pinned-b")).not.toBeInTheDocument()
    expect(screen.getByTestId("recent-runs-stub")).toBeInTheDocument()
  })

  it("shows the Active badge for a running workflow", () => {
    pushQueries({ workflows: [wf("a", "Alpha")], runs: [{ workflowId: "a" }] })
    render(<WorkflowList />)
    expect(screen.getByTestId("workflow-active-a")).toBeInTheDocument()
  })

  it("shows the Sending badge for a workflow with a queued trigger", () => {
    pushQueries({
      workflows: [wf("a", "Alpha")],
      triggers: [{ status: "sending", payload: { workflowId: "a" } }],
    })
    render(<WorkflowList />)
    expect(screen.getByTestId("workflow-sending-a")).toBeInTheDocument()
  })

  it("prefers the Active badge over Sending when a run is already live", () => {
    pushQueries({
      workflows: [wf("a", "Alpha")],
      runs: [{ workflowId: "a" }],
      triggers: [{ status: "pending", payload: { workflowId: "a" } }],
    })
    render(<WorkflowList />)
    expect(screen.getByTestId("workflow-active-a")).toBeInTheDocument()
    expect(screen.queryByTestId("workflow-sending-a")).not.toBeInTheDocument()
  })

  it("renders child folders and enters one on tap", () => {
    pushQueries({ folders: [{ id: "f1", name: "Reports" }], workflows: [] })
    render(<WorkflowList />)
    expect(screen.getByTestId("mobile-workflow-folder-f1")).toHaveTextContent("Reports")
    fireEvent.click(screen.getByTestId("mobile-workflow-folder-f1"))
    expect(useWorkflowLibraryStore.getState().currentFolderId).toBe("f1")
  })

  it("shows the breadcrumb and hides pinned/recent inside a sub-folder", () => {
    useWorkflowLibraryStore.setState({ currentFolderId: "f1" })
    settingsRef.value = { pinnedWorkflowIds: ["a"] }
    pushQueries({ path: [{ id: "f1", name: "Reports" }], workflows: [wf("a", "Alpha")] })
    render(<WorkflowList />)
    expect(screen.getByTestId("breadcrumb-stub")).toHaveTextContent("1")
    expect(screen.queryByTestId("pinned-section-stub")).not.toBeInTheDocument()
    expect(screen.queryByTestId("recent-runs-stub")).not.toBeInTheDocument()
  })

  it("opens the create dialog from the toolbar", () => {
    pushQueries({})
    render(<WorkflowList />)
    expect(screen.queryByTestId("create-dialog-open")).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId("toolbar-new"))
    expect(screen.getByTestId("create-dialog-open")).toBeInTheDocument()
  })

  it("long-press opens the action sheet whose pin delegates to save", async () => {
    pushQueries({ workflows: [wf("a", "Alpha")] })
    render(<WorkflowList />)
    fireEvent.contextMenu(screen.getAllByTestId("long-press-stub")[0])
    await waitFor(() =>
      expect(screen.getByTestId("workflow-row-actions-sheet")).toBeInTheDocument()
    )
    fireEvent.click(screen.getByTestId("workflow-action-pin"))
    await waitFor(() => expect(saveMock).toHaveBeenCalledTimes(1))
    expect(saveMock.mock.calls[0][0]).toEqual({ pinnedWorkflowIds: ["a"] })
  })
})

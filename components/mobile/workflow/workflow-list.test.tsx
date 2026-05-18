/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react"

import type { WorkflowRow } from "@/types/workflow/visual"

import { WorkflowList } from "./workflow-list"

jest.mock("next/link", () => {
  const Link = ({ children, href, ...rest }: { children: React.ReactNode; href: string }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  )
  return { __esModule: true, default: Link }
})

const liveQueries: Array<unknown> = []
jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: (factory: () => unknown) => {
    void factory
    return liveQueries.shift()
  },
}))

jest.mock("@/lib/db/workflows", () => ({
  listWorkflows: () => Promise.resolve([]),
}))

jest.mock("@/lib/db/schema", () => ({
  getDb: () => ({
    workflowRuns: {
      where: () => ({ equals: () => ({ toArray: () => Promise.resolve([]) }) }),
      orderBy: () => ({
        reverse: () => ({ limit: () => ({ toArray: () => Promise.resolve([]) }) }),
      }),
    },
  }),
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
  LongPress: ({
    children,
    onLongPress,
  }: {
    children: React.ReactNode
    onLongPress: () => void
  }) => (
    // Use onContextMenu as a stand-in for long-press so tests can fire it
    // synchronously without involving timers.
    <span data-testid="long-press-stub" onContextMenu={() => onLongPress()}>
      {children}
    </span>
  ),
}))

jest.mock("@/components/mobile/empty-state", () => ({
  EmptyState: ({ title }: { title: string }) => <div data-testid="empty-state">{title}</div>,
}))

jest.mock("sonner", () => ({
  toast: { success: jest.fn() },
}))

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => {
    const map: Record<string, string> = {
      title: "Workflows",
      empty: "Empty",
      all: "All workflows",
      pinned: "Pinned",
      activeBadge: "Active",
      pinned_added: "Pinned",
      pinned_removed: "Unpinned",
    }
    return map[key] ?? key
  },
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

beforeEach(() => {
  liveQueries.length = 0
  saveMock.mockReset()
  saveMock.mockResolvedValue(undefined)
  settingsRef.value = { pinnedWorkflowIds: [] }
})

describe("<WorkflowList />", () => {
  it("renders the empty state when no workflows exist", () => {
    liveQueries.push([], [])
    render(<WorkflowList />)
    expect(screen.getByTestId("empty-state")).toHaveTextContent("Empty")
    expect(screen.queryByTestId("pinned-section-stub")).not.toBeInTheDocument()
  })

  it("renders rows + pinned + recent feed when workflows exist", () => {
    liveQueries.push([wf("a", "Alpha", "Daily snap"), wf("b", "Beta")], [])
    settingsRef.value = { pinnedWorkflowIds: ["a"] }
    render(<WorkflowList />)
    expect(screen.getByTestId("pinned-section-stub")).toHaveTextContent("1")
    expect(screen.getByTestId("workflow-row-a")).toBeInTheDocument()
    expect(screen.getByTestId("workflow-row-b")).toBeInTheDocument()
    expect(screen.getByTestId("workflow-pinned-a")).toBeInTheDocument()
    expect(screen.queryByTestId("workflow-pinned-b")).not.toBeInTheDocument()
    expect(screen.getByTestId("recent-runs-stub")).toBeInTheDocument()
  })

  it("shows the Active badge when a workflow has a running run", () => {
    liveQueries.push([wf("a", "Alpha")], [{ workflowId: "a" }])
    render(<WorkflowList />)
    expect(screen.getByTestId("workflow-active-a")).toBeInTheDocument()
  })

  it("falls back to empty pinnedIds when settings haven't loaded", () => {
    liveQueries.push([wf("a")], [])
    settingsRef.value = null
    render(<WorkflowList />)
    expect(screen.queryByTestId("pinned-section-stub")).not.toBeInTheDocument()
  })

  it("toggles pin on long-press (add when missing)", async () => {
    liveQueries.push([wf("a", "Alpha")], [])
    settingsRef.value = { pinnedWorkflowIds: [] }
    render(<WorkflowList />)
    fireEvent.contextMenu(screen.getAllByTestId("long-press-stub")[0])
    await waitFor(() => expect(saveMock).toHaveBeenCalledTimes(1))
    expect(saveMock.mock.calls[0][0]).toEqual({ pinnedWorkflowIds: ["a"] })
  })

  it("toggles pin on long-press (remove when already pinned)", async () => {
    liveQueries.push([wf("a", "Alpha"), wf("b", "Beta")], [])
    settingsRef.value = { pinnedWorkflowIds: ["a", "b"] }
    render(<WorkflowList />)
    fireEvent.contextMenu(screen.getAllByTestId("long-press-stub")[0])
    await waitFor(() => expect(saveMock).toHaveBeenCalledTimes(1))
    expect(saveMock.mock.calls[0][0]).toEqual({ pinnedWorkflowIds: ["b"] })
  })
})

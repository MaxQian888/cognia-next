/**
 * @jest-environment jsdom
 */
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import type { Memory } from "@/types/memory/memory"

let mockData: Memory[] | undefined = []
jest.mock("@/hooks/ui", () => {
  const actual = jest.requireActual("@/hooks/ui")
  return {
    ...actual,
    useLiveQueryState: () => ({
      data: mockData,
      isLoading: mockData === undefined,
      isEmpty: mockData !== undefined && mockData.length === 0,
    }),
  }
})
jest.mock("@/hooks/data", () => ({
  useClientLiveQuery: (query: () => unknown) => {
    const result = query()
    return result instanceof Promise ? [] : result
  },
}))

// jsdom has no layout — render every item so count/text assertions hold.
const scrollToIndexMock = jest.fn()
jest.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({
        index,
        key: index,
        start: index * 88,
        size: 88,
        end: (index + 1) * 88,
        lane: 0,
      })),
    getTotalSize: () => count * 88,
    measureElement: jest.fn(),
    scrollToIndex: (...args: unknown[]) => scrollToIndexMock(...args),
  }),
}))

const mockToastError = jest.fn()
const mockToastSuccess = jest.fn()
jest.mock("sonner", () => ({
  toast: {
    error: (...args: unknown[]) => mockToastError(...args),
    success: (...args: unknown[]) => mockToastSuccess(...args),
    warning: jest.fn(),
  },
}))

const mockRunSyncDown = jest.fn().mockResolvedValue([])
jest.mock("@/lib/sync/companion-sync", () => ({
  runSyncDown: (...args: unknown[]) => mockRunSyncDown(...args),
}))

let mockAuthority: "local" | "host" = "local"
const mockRun = jest.fn()
jest.mock("@/lib/memory/control-plane/routed-manage", () => ({
  memoryWriteAuthority: () => mockAuthority,
  subscribeMemoryWriteAuthority: () => () => {},
  runMemoryCommand: (...args: unknown[]) => mockRun(...args),
}))

jest.mock("@/lib/db/memories", () => ({
  listMemories: jest.fn(),
  listMemoryRevisions: jest.fn(async () => []),
}))
jest.mock("@/lib/db/characters", () => ({ listCharacters: jest.fn(async () => []) }))
jest.mock("@/lib/db/memory-governance", () => ({
  listMemoryEvidence: jest.fn(async () => []),
  listMemoryAuditEvents: jest.fn(async () => []),
}))
jest.mock("@/lib/memory/lint/run-memory-lint", () => ({
  runMemoryLint: jest.fn(async () => ({ findings: [], contradictionCheck: "ran", scanned: 0 })),
}))
jest.mock("@/lib/tauri", () => ({ isTauri: () => false }))
jest.mock("@/hooks/use-runtime-snapshot", () => ({
  useRuntimeSnapshot: () => ({ connectionState: "online", target: null, vaultState: "unlocked" }),
}))
jest.mock("@/components/interactions/pull-to-refresh", () => ({
  PullToRefresh: ({
    children,
    onRefresh,
  }: {
    children: React.ReactNode
    onRefresh: () => Promise<void> | void
  }) => (
    <div>
      <button onClick={() => void onRefresh()}>refresh</button>
      {children}
    </div>
  ),
}))

import { MemoryMobileBody } from "./memory-mobile-body"

let seq = 0
function mem(over: Partial<Memory> = {}): Memory {
  seq += 1
  const now = 1_700_000_000_000
  return {
    id: over.id ?? `m${seq}`,
    scope: "global",
    type: "semantic",
    text: `memory ${seq}`,
    tags: [],
    importance: 5,
    createdAt: now,
    updatedAt: now,
    lastAccessedAt: now,
    accessCount: 0,
    version: 1,
    status: "active",
    pinned: false,
    provenance: "user",
    ...over,
  }
}

const rows = () => screen.queryAllByTestId("memory-touch-row")

beforeEach(() => {
  seq = 0
  mockData = []
  mockAuthority = "local"
  mockRun.mockReset()
  mockRun.mockResolvedValue({ ok: true })
  mockRunSyncDown.mockClear()
  mockToastError.mockClear()
  mockToastSuccess.mockClear()
  scrollToIndexMock.mockClear()
  window.history.replaceState({}, "", "/memory")
})

describe("MemoryMobileBody — layout", () => {
  it("renders a full-bleed list with the title in a sticky header", () => {
    mockData = [mem({ text: "likes tea" }), mem({ text: "lives in Shanghai" })]
    render(<MemoryMobileBody />)
    expect(screen.getByTestId("mobile-memory-body").className).toContain("w-full")
    expect(screen.getByRole("heading", { name: "Memory" })).toBeInTheDocument()
    expect(rows()).toHaveLength(2)
    // No resident per-row buttons: one menu per row.
    expect(within(rows()[0]!).getAllByRole("button", { name: "More actions" })).toHaveLength(1)
  })

  it("gives the screen a way back to the hub that opened it", () => {
    render(<MemoryMobileBody />)
    expect(screen.getByRole("button", { name: /back/i })).toBeInTheDocument()
  })

  it("shows a skeleton, not the empty state, before the first read", () => {
    mockData = undefined
    render(<MemoryMobileBody />)
    expect(screen.getByTestId("mobile-memory-loading")).toBeInTheDocument()
    expect(screen.queryByText("No memories yet")).toBeNull()
  })

  it("explains an empty store and offers to add the first memory", async () => {
    render(<MemoryMobileBody />)
    expect(screen.getByText("No memories yet")).toBeInTheDocument()
    await userEvent.click(screen.getByTestId("mobile-memory-add-first"))
    expect(screen.getByRole("dialog", { name: "Add memory" })).toBeInTheDocument()
  })

  it("only offers the external tab where agent files are on this machine", () => {
    render(<MemoryMobileBody />)
    expect(screen.getByTestId("mobile-memory-tab-app")).toBeInTheDocument()
    expect(screen.getByTestId("mobile-memory-tab-health")).toBeInTheDocument()
    expect(screen.queryByTestId("mobile-memory-tab-external")).toBeNull()
  })

  it("switches to the health tab", async () => {
    mockData = [mem()]
    render(<MemoryMobileBody />)
    await userEvent.click(screen.getByTestId("mobile-memory-tab-health"))
    expect(screen.getByTestId("memory-health-panel")).toBeInTheDocument()
    expect(rows()).toHaveLength(0)
  })
})

describe("MemoryMobileBody — finding memories", () => {
  it("filters by the search query and tells no-hits apart from an empty store", async () => {
    mockData = [mem({ text: "likes tea" }), mem({ text: "lives in Shanghai" })]
    render(<MemoryMobileBody />)
    fireEvent.change(screen.getByTestId("mobile-memory-search"), { target: { value: "tea" } })
    await waitFor(() => expect(rows()).toHaveLength(1))
    fireEvent.change(screen.getByTestId("mobile-memory-search"), { target: { value: "zzz" } })
    await waitFor(() => expect(screen.getByText("No memories match")).toBeInTheDocument())
    await userEvent.click(screen.getByTestId("mobile-memory-clear-search"))
    await waitFor(() => expect(rows()).toHaveLength(2))
  })

  it("shows only one workspace's memories when opened for it", () => {
    mockData = [
      mem({ text: "here", scope: "workspace", projectId: "p1" }),
      mem({ text: "elsewhere", scope: "workspace", projectId: "p2" }),
    ]
    render(<MemoryMobileBody projectId="p1" />)
    expect(rows()).toHaveLength(1)
    expect(screen.getByText("here")).toBeInTheDocument()
  })

  it("narrows by quick view", async () => {
    mockData = [mem({ pinned: true, text: "pinned one" }), mem({ text: "plain" })]
    render(<MemoryMobileBody />)
    await userEvent.click(screen.getByTestId("memory-view-pinned"))
    expect(rows()).toHaveLength(1)
    expect(screen.getByText("pinned one")).toBeInTheDocument()
  })

  it("opens filter and sort in a drawer", async () => {
    mockData = [mem({ type: "episodic" }), mem({ type: "semantic" })]
    render(<MemoryMobileBody />)
    await userEvent.click(screen.getByTestId("mobile-memory-filter"))
    expect(await screen.findByTestId("memory-filter-drawer")).toBeInTheDocument()
    // vaul reads pointer transforms jsdom does not compute; a click is what matters.
    fireEvent.click(screen.getByTestId("memory-drawer-types-episodic"))
    await waitFor(() => expect(rows()).toHaveLength(1))
  })

  it("scrolls the deep-linked memory into view once", () => {
    mockData = [mem({ id: "a" }), mem({ id: "b" })]
    render(<MemoryMobileBody initialSelectedId="b" />)
    expect(scrollToIndexMock).toHaveBeenCalledTimes(1)
    expect(scrollToIndexMock).toHaveBeenCalledWith(1, { align: "center" })
  })
})

describe("MemoryMobileBody — acting on memories", () => {
  it("opens the inspector as a sheet on tap", async () => {
    mockData = [mem({ id: "a", text: "likes tea" })]
    render(<MemoryMobileBody />)
    await userEvent.click(within(rows()[0]!).getByTestId("memory-touch-open"))
    const sheet = await screen.findByTestId("mobile-memory-inspector")
    expect(within(sheet).getByTestId("memory-inspector")).toHaveAttribute("data-memory-id", "a")
  })

  it("edits from the row menu by opening the inspector's editor", async () => {
    mockData = [mem({ id: "a" })]
    render(<MemoryMobileBody />)
    await userEvent.click(within(rows()[0]!).getByTestId("memory-touch-more"))
    await userEvent.click(screen.getByRole("menuitem", { name: "Edit" }))
    const sheet = await screen.findByTestId("mobile-memory-inspector")
    expect(within(sheet).getByRole("textbox", { name: "Text" })).toBeInTheDocument()
  })

  it("pins from the row menu with the desired state", async () => {
    mockData = [mem({ id: "a" })]
    render(<MemoryMobileBody />)
    await userEvent.click(within(rows()[0]!).getByTestId("memory-touch-more"))
    await userEvent.click(screen.getByRole("menuitem", { name: "Pin" }))
    await waitFor(() =>
      expect(mockRun).toHaveBeenCalledWith(
        { kind: "pin", id: "a", pinned: true },
        expect.objectContaining({ authority: "local" })
      )
    )
  })

  it("confirms a permanent delete before it runs", async () => {
    mockData = [mem({ id: "a" })]
    render(<MemoryMobileBody />)
    await userEvent.click(within(rows()[0]!).getByTestId("memory-touch-more"))
    await userEvent.click(screen.getByTestId("memory-touch-delete"))
    expect(mockRun).not.toHaveBeenCalled()
    await userEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Delete" }))
    await waitFor(() =>
      expect(mockRun).toHaveBeenCalledWith({ kind: "delete", id: "a" }, expect.anything())
    )
  })

  it("restores an archived memory from its menu", async () => {
    mockData = [mem({ id: "a", status: "invalidated", invalidatedAt: 1 })]
    render(<MemoryMobileBody />)
    await userEvent.click(screen.getByTestId("memory-view-archived"))
    await userEvent.click(within(rows()[0]!).getByTestId("memory-touch-more"))
    await userEvent.click(screen.getByTestId("memory-touch-restore"))
    await waitFor(() =>
      expect(mockRun).toHaveBeenCalledWith({ kind: "restore", id: "a" }, expect.anything())
    )
  })

  it("selects by long press and acts on the selection from the header", async () => {
    jest.useFakeTimers()
    try {
      mockData = [mem({ id: "a" }), mem({ id: "b" })]
      render(<MemoryMobileBody />)
      const target = within(rows()[0]!).getByTestId("memory-touch-open").parentElement!
      fireEvent.pointerDown(target, { pointerType: "touch", clientX: 0, clientY: 0 })
      act(() => {
        jest.advanceTimersByTime(600)
      })
      fireEvent.pointerUp(target)
      expect(screen.getByTestId("memory-bulk-toolbar")).toHaveAttribute("data-layout", "compact")
      expect(screen.queryByTestId("mobile-memory-search")).toBeNull()
      // A tap now toggles instead of opening.
      fireEvent.click(within(rows()[1]!).getByTestId("memory-touch-open"))
      expect(screen.getByTestId("memory-bulk-count")).toHaveTextContent("2")
    } finally {
      jest.useRealTimers()
    }
    await userEvent.click(screen.getByTestId("memory-bulk-archive"))
    await waitFor(() => expect(mockRun).toHaveBeenCalledTimes(2))
    expect(mockRun).toHaveBeenCalledWith({ kind: "invalidate", id: "a" }, expect.anything())
    expect(mockRun).toHaveBeenCalledWith({ kind: "invalidate", id: "b" }, expect.anything())
  })
})

describe("MemoryMobileBody — who owns the store", () => {
  it("re-reads on pull when this device owns its memory — there is no host to pull from", async () => {
    render(<MemoryMobileBody />)
    await userEvent.click(screen.getByText("refresh"))
    expect(mockRunSyncDown).not.toHaveBeenCalled()
    expect(screen.queryByTestId("memory-host-chip")).toBeNull()
  })

  it("pulls memories from the host and says whose memory this is on a paired device", async () => {
    mockAuthority = "host"
    render(<MemoryMobileBody />)
    expect(screen.getByTestId("memory-host-chip")).toBeInTheDocument()
    await userEvent.click(screen.getByText("refresh"))
    await waitFor(() => expect(mockRunSyncDown).toHaveBeenCalledWith({ only: ["memories"] }))
  })

  it("surfaces a toast when a command fails", async () => {
    mockRun.mockRejectedValueOnce(new Error("no runtime target"))
    mockData = [mem({ id: "a" })]
    render(<MemoryMobileBody />)
    await userEvent.click(within(rows()[0]!).getByTestId("memory-touch-more"))
    await userEvent.click(screen.getByRole("menuitem", { name: "Pin" }))
    await waitFor(() => expect(mockToastError).toHaveBeenCalled())
  })
})

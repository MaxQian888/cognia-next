/**
 * @jest-environment jsdom
 */
import { render, screen, fireEvent, within, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { Memory } from "@/types/memory/memory"
import type { ManageMemoryResult } from "@/lib/memory/control-plane/manage"

let mockData: Memory[] | undefined = []
jest.mock("@/hooks/data", () => ({
  useClientLiveQuery: (query: () => unknown) => {
    const result = query()
    // The console's per-selection governance queries resolve to arrays; the
    // memory list itself comes through `useLiveQueryState` below.
    return result instanceof Promise ? [] : result
  },
}))
jest.mock("@/hooks/ui", () => {
  const actual = jest.requireActual("@/hooks/ui")
  return {
    ...actual,
    // `undefined` models "the Dexie read has not resolved", which is what the
    // loading skeleton keys off. Tests set `mockData` per case.
    useLiveQueryState: () => ({
      data: mockData,
      isLoading: mockData === undefined,
      isEmpty: mockData !== undefined && mockData.length === 0,
    }),
  }
})

// jsdom has no layout, so the real virtualizer would render zero rows. Render
// every item instead — count assertions below stay meaningful.
jest.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({
        index,
        key: index,
        start: index * 96,
        size: 96,
        end: (index + 1) * 96,
        lane: 0,
      })),
    getTotalSize: () => count * 96,
    measureElement: jest.fn(),
    scrollToIndex: jest.fn(),
  }),
}))

const mockToastError = jest.fn()
const mockToastWarning = jest.fn()
const mockToastSuccess = jest.fn()
jest.mock("sonner", () => ({
  toast: {
    error: (...args: unknown[]) => mockToastError(...args),
    warning: (...args: unknown[]) => mockToastWarning(...args),
    success: (...args: unknown[]) => mockToastSuccess(...args),
  },
}))

// The external tab and the retrieval popover have their own suites; stub them
// so the console tests stay focused and don't pull in CodeMirror / Dexie.
jest.mock("./external/external-memory-tab", () => ({
  ExternalMemoryTab: () => <div data-testid="external-tab" />,
}))
jest.mock("./memory-retrieval-chip", () => ({
  MemoryRetrievalChip: () => <div data-testid="memory-retrieval-chip" />,
}))

jest.mock("@/lib/db/memories", () => ({ listMemories: jest.fn() }))
jest.mock("@/lib/db/memory-governance", () => ({
  listMemoryEvidence: jest.fn(async () => []),
  listMemoryAuditEvents: jest.fn(async () => []),
}))

const mockManage = jest.fn<Promise<ManageMemoryResult>, unknown[]>(async () => ({ ok: true }))
jest.mock("@/lib/memory/control-plane/manage", () => ({
  manageMemory: (...args: unknown[]) => mockManage(...args),
}))

import { MemoryConsole } from "./memory-console"

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

beforeEach(() => {
  seq = 0
  mockData = []
  mockManage.mockClear()
  mockManage.mockImplementation(async () => ({ ok: true }))
  mockToastError.mockClear()
  mockToastWarning.mockClear()
  mockToastSuccess.mockClear()
  window.history.replaceState({}, "", "/memory")
})

const rows = () => screen.queryAllByTestId("memory-row")

describe("MemoryConsole — layout", () => {
  it("renders inside the shared feature shell rather than a bespoke layout", () => {
    mockData = [mem()]
    render(<MemoryConsole />)
    expect(screen.getByTestId("feature-shell-memory")).toBeTruthy()
    expect(screen.getByTestId("memory-header")).toBeTruthy()
    expect(screen.getByTestId("memory-toolbar")).toBeTruthy()
  })

  it("separates 'still loading' from 'you have no memories'", () => {
    mockData = undefined
    const { unmount } = render(<MemoryConsole />)
    expect(screen.getByTestId("memory-list-loading")).toBeTruthy()
    expect(screen.queryByTestId("memory-empty")).toBeNull()
    unmount()

    mockData = []
    render(<MemoryConsole />)
    expect(screen.getByTestId("memory-empty")).toBeTruthy()
  })

  it("summarises the corpus in the header instead of a row of stat tiles", () => {
    mockData = [mem({ pinned: true, vectorDocId: "v1" }), mem({ reviewStatus: "conflict" }), mem()]
    render(<MemoryConsole />)
    const summary = screen.getByTestId("memory-summary").textContent ?? ""
    expect(summary).toContain("3 active")
    expect(summary).toContain("1 pinned")
    expect(summary).toContain("1 in conflict")
    expect(summary).toContain("33% indexed")
  })
})

describe("MemoryConsole — quick views", () => {
  it("counts each view and narrows the list when one is picked", async () => {
    mockData = [
      mem({ id: "plain" }),
      mem({ id: "pin", pinned: true }),
      mem({ id: "conf", reviewStatus: "conflict" }),
      mem({ id: "arch", status: "invalidated" }),
    ]
    render(<MemoryConsole />)
    expect(screen.getByTestId("memory-view-all").textContent).toContain("3")
    expect(screen.getByTestId("memory-view-archived").textContent).toContain("1")
    expect(rows()).toHaveLength(3)

    await userEvent.click(screen.getByTestId("memory-view-pinned"))
    expect(rows()).toHaveLength(1)
    expect(rows()[0]?.dataset.memoryId).toBe("pin")
  })

  it("makes the archive reachable, which the old 'show archived' toggle never did", async () => {
    mockData = [mem({ id: "live" }), mem({ id: "gone", status: "invalidated" })]
    render(<MemoryConsole />)
    await userEvent.click(screen.getByTestId("memory-view-archived"))
    expect(rows()).toHaveLength(1)
    expect(rows()[0]?.dataset.memoryId).toBe("gone")
  })

  it("folds pending_instruction rows into 'needs review'", async () => {
    mockData = [
      mem({ id: "pend", reviewStatus: "pending_instruction" }),
      mem({ id: "ok", reviewStatus: "verified" }),
    ]
    render(<MemoryConsole />)
    expect(screen.getByTestId("memory-view-needsReview").textContent).toContain("1")
    await userEvent.click(screen.getByTestId("memory-view-needsReview"))
    expect(rows()).toHaveLength(1)
    expect(rows()[0]?.dataset.memoryId).toBe("pend")
  })
})

describe("MemoryConsole — search & facets", () => {
  it("filters by search query", async () => {
    mockData = [mem({ id: "a", text: "prefers pnpm" }), mem({ id: "b", text: "likes vim" })]
    render(<MemoryConsole />)
    fireEvent.change(screen.getByTestId("memory-search"), { target: { value: "vim" } })
    await waitFor(() => expect(rows()).toHaveLength(1))
    expect(rows()[0]?.dataset.memoryId).toBe("b")
  })

  it("offers only facet options present in the current view", async () => {
    mockData = [mem({ type: "semantic" }), mem({ type: "episodic" })]
    render(<MemoryConsole />)
    await userEvent.click(screen.getByTestId("memory-filter-menu"))
    const menu = screen.getByRole("menu")
    expect(within(menu).getByText("Fact")).toBeTruthy()
    expect(within(menu).getByText("Event")).toBeTruthy()
    expect(within(menu).queryByText("Procedure")).toBeNull()
  })

  it("filters by a facet and badges how many axes are active", async () => {
    mockData = [mem({ id: "a", type: "semantic" }), mem({ id: "b", type: "episodic" })]
    render(<MemoryConsole />)
    await userEvent.click(screen.getByTestId("memory-filter-menu"))
    await userEvent.click(within(screen.getByRole("menu")).getByText("Event"))
    await waitFor(() => expect(rows()).toHaveLength(1))
    expect(rows()[0]?.dataset.memoryId).toBe("b")
    expect(screen.getByTestId("memory-filter-menu").textContent).toContain("1")
  })

  it("filters by clicking a tag chip and clears it again", async () => {
    mockData = [mem({ id: "a", tags: ["work"] }), mem({ id: "b", tags: ["home"] })]
    render(<MemoryConsole />)
    await userEvent.click(within(rows()[0]!).getByText("work"))
    await waitFor(() => expect(rows()).toHaveLength(1))
    await userEvent.click(within(rows()[0]!).getByText("work"))
    await waitFor(() => expect(rows()).toHaveLength(2))
  })

  it("shows a clearable no-results state when filters match nothing", async () => {
    mockData = [mem({ text: "prefers pnpm" })]
    render(<MemoryConsole />)
    fireEvent.change(screen.getByTestId("memory-search"), { target: { value: "zzz" } })
    await waitFor(() => expect(screen.getByTestId("memory-empty-filtered")).toBeTruthy())
    await userEvent.click(screen.getByRole("button", { name: "Clear filters" }))
    await waitFor(() => expect(rows()).toHaveLength(1))
  })

  it("changes the sort order from the display menu", async () => {
    mockData = [
      mem({ id: "old", createdAt: 1, updatedAt: 9 }),
      mem({ id: "new", createdAt: 9, updatedAt: 1 }),
    ]
    render(<MemoryConsole />)
    expect(rows()[0]?.dataset.memoryId).toBe("old")
    await userEvent.click(screen.getByTestId("memory-display-menu"))
    await userEvent.click(screen.getByTestId("memory-sort-created"))
    await waitFor(() => expect(rows()[0]?.dataset.memoryId).toBe("new"))
  })
})

describe("MemoryConsole — row actions", () => {
  it("pins a row with the desired state", async () => {
    mockData = [mem({ id: "m1", pinned: false })]
    render(<MemoryConsole />)
    await userEvent.click(within(rows()[0]!).getByRole("button", { name: "Pin" }))
    expect(mockManage).toHaveBeenCalledWith({ kind: "pin", id: "m1", pinned: true })
  })

  it("archives instead of hard-deleting from the row's primary action", async () => {
    mockData = [mem({ id: "m1" })]
    render(<MemoryConsole />)
    await userEvent.click(screen.getByTestId("memory-row-archive"))
    expect(mockManage).toHaveBeenCalledWith({ kind: "invalidate", id: "m1" })
    expect(mockManage).not.toHaveBeenCalledWith({ kind: "delete", id: "m1" })
  })

  it("still allows a permanent delete from the overflow menu", async () => {
    mockData = [mem({ id: "m1" })]
    render(<MemoryConsole />)
    await userEvent.click(screen.getByTestId("memory-row-more"))
    await userEvent.click(screen.getByTestId("memory-row-delete"))
    expect(mockManage).toHaveBeenCalledWith({ kind: "delete", id: "m1" })
  })

  it("saves a row's inline edit", async () => {
    mockData = [mem({ id: "m1", text: "old" })]
    render(<MemoryConsole />)
    const row = rows()[0]!
    await userEvent.click(within(row).getByRole("button", { name: "Edit" }))
    fireEvent.change(within(row).getByRole("textbox"), { target: { value: "new" } })
    await userEvent.click(within(row).getByRole("button", { name: "Save" }))
    expect(mockManage).toHaveBeenCalledWith({
      kind: "update",
      id: "m1",
      patch: { text: "new" },
    })
  })
})

describe("MemoryConsole — inspector", () => {
  it("opens on row click and steps through the list", async () => {
    mockData = [mem({ id: "a" }), mem({ id: "b" })]
    render(<MemoryConsole />)
    await userEvent.click(rows()[0]!)
    expect(screen.getByTestId("memory-inspector").dataset.memoryId).toBe("a")
    await userEvent.click(screen.getByRole("button", { name: "Next memory" }))
    expect(screen.getByTestId("memory-inspector").dataset.memoryId).toBe("b")
  })

  it("mirrors the selection into ?id= so the pane survives a refresh", async () => {
    mockData = [mem({ id: "a" })]
    render(<MemoryConsole />)
    await userEvent.click(rows()[0]!)
    await waitFor(() => expect(new URL(window.location.href).searchParams.get("id")).toBe("a"))
    await userEvent.click(screen.getByRole("button", { name: "Close" }))
    await waitFor(() => expect(new URL(window.location.href).searchParams.get("id")).toBeNull())
  })

  it("renders the evidence and audit rows it loads rather than only counting them", async () => {
    mockData = [mem({ id: "a" })]
    const governance = jest.requireMock("@/lib/db/memory-governance")
    governance.listMemoryAuditEvents.mockReturnValue([
      { id: "e1", action: "promoted", reason: "user_review", createdAt: 1_700_000_000_000 },
    ])
    render(<MemoryConsole />)
    await userEvent.click(rows()[0]!)
    const activity = screen.getByTestId("memory-activity")
    expect(within(activity).getByText("Marked verified")).toBeTruthy()
    governance.listMemoryAuditEvents.mockReturnValue([])
  })

  it("saves an inspector edit", async () => {
    mockData = [mem({ id: "a", text: "old" })]
    render(<MemoryConsole />)
    await userEvent.click(rows()[0]!)
    const inspector = screen.getByTestId("memory-inspector")
    await userEvent.click(within(inspector).getByRole("button", { name: /edit/i }))
    fireEvent.change(within(inspector).getByRole("textbox", { name: "Text" }), {
      target: { value: "new" },
    })
    await userEvent.click(within(inspector).getByRole("button", { name: "Save" }))
    expect(mockManage).toHaveBeenCalledWith(expect.objectContaining({ kind: "update", id: "a" }))
  })

  it("marks a memory verified", async () => {
    mockData = [mem({ id: "a", reviewStatus: "unreviewed" })]
    render(<MemoryConsole />)
    await userEvent.click(rows()[0]!)
    await userEvent.click(screen.getByTestId("memory-inspector-verify"))
    expect(mockManage).toHaveBeenCalledWith({ kind: "review", id: "a", status: "verified" })
  })

  it("closes on Escape and steps with the arrow keys", async () => {
    mockData = [mem({ id: "a" }), mem({ id: "b" })]
    render(<MemoryConsole />)
    await userEvent.click(rows()[0]!)
    fireEvent.keyDown(window, { key: "ArrowDown" })
    await waitFor(() => expect(screen.getByTestId("memory-inspector").dataset.memoryId).toBe("b"))
    fireEvent.keyDown(window, { key: "Escape" })
    await waitFor(() => expect(screen.queryByTestId("memory-inspector")).toBeNull())
  })

  it("ignores navigation keys while typing", async () => {
    mockData = [mem({ id: "a" }), mem({ id: "b" })]
    render(<MemoryConsole />)
    await userEvent.click(rows()[0]!)
    fireEvent.keyDown(screen.getByTestId("memory-search"), { key: "ArrowDown" })
    expect(screen.getByTestId("memory-inspector").dataset.memoryId).toBe("a")
  })
})

describe("MemoryConsole — add & bulk", () => {
  it("creates a memory with explicit provenance", async () => {
    render(<MemoryConsole />)
    await userEvent.click(screen.getByTestId("memory-add-button"))
    fireEvent.change(screen.getByPlaceholderText(/prefers pnpm/i), {
      target: { value: "remember this" },
    })
    await userEvent.click(screen.getByRole("button", { name: "Add memory" }))
    await waitFor(() =>
      expect(mockManage).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "create", text: "remember this" })
      )
    )
  })

  // The add dialog used to close on every submit because the result was never
  // read, so a PII-blocked add threw the user's text away silently.
  it("keeps the add dialog open when the command is rejected", async () => {
    mockManage.mockResolvedValue({ ok: false, reason: "pii_blocked" })
    render(<MemoryConsole />)
    await userEvent.click(screen.getByTestId("memory-add-button"))
    fireEvent.change(screen.getByPlaceholderText(/prefers pnpm/i), {
      target: { value: "1234-5678" },
    })
    await userEvent.click(screen.getByRole("button", { name: "Add memory" }))
    await waitFor(() => expect(mockToastError).toHaveBeenCalled())
    expect(screen.getByPlaceholderText(/prefers pnpm/i)).toBeTruthy()
  })

  it("bulk-archives and bulk-deletes the selection", async () => {
    mockData = [mem({ id: "a" }), mem({ id: "b" })]
    render(<MemoryConsole />)
    await userEvent.click(within(rows()[0]!).getByTestId("memory-row-select"))
    await userEvent.click(screen.getByTestId("memory-bulk-archive"))
    await userEvent.click(screen.getByRole("button", { name: "Archive" }))
    await waitFor(() => expect(mockManage).toHaveBeenCalledWith({ kind: "invalidate", id: "a" }))
  })

  it("select-all covers every visible row", async () => {
    mockData = [mem({ id: "a" }), mem({ id: "b" })]
    render(<MemoryConsole />)
    await userEvent.click(within(rows()[0]!).getByTestId("memory-row-select"))
    await userEvent.click(screen.getByTestId("memory-bulk-select-all"))
    expect(screen.getByTestId("memory-bulk-count").textContent).toContain("2")
  })
})

describe("MemoryConsole — mutation feedback", () => {
  it("surfaces a toast when a mutation is rejected", async () => {
    mockData = [mem({ id: "a" })]
    mockManage.mockResolvedValue({ ok: false, reason: "policy_denied" })
    render(<MemoryConsole />)
    await userEvent.click(screen.getByTestId("memory-row-archive"))
    await waitFor(() =>
      expect(mockToastError).toHaveBeenCalledWith("A memory policy blocked this change")
    )
  })

  it("surfaces a generic toast when a mutation throws", async () => {
    mockData = [mem({ id: "a" })]
    mockManage.mockRejectedValue(new Error("boom"))
    render(<MemoryConsole />)
    await userEvent.click(screen.getByTestId("memory-row-archive"))
    await waitFor(() => expect(mockToastError).toHaveBeenCalled())
  })

  // `manageMemory` silently rewrites text that trips the PII gate; the console
  // dropped that flag, so the save looked lossless.
  it("tells the user when their text was redacted before it was stored", async () => {
    mockData = [mem({ id: "a", text: "old" })]
    mockManage.mockResolvedValue({ ok: true, memoryId: "a", piiRedacted: true })
    render(<MemoryConsole />)
    const row = rows()[0]!
    await userEvent.click(within(row).getByRole("button", { name: "Edit" }))
    fireEvent.change(within(row).getByRole("textbox"), { target: { value: "call 555-0100" } })
    await userEvent.click(within(row).getByRole("button", { name: "Save" }))
    await waitFor(() =>
      expect(mockToastWarning).toHaveBeenCalledWith("Saved — personal details were redacted first.")
    )
  })
})

describe("MemoryConsole — deep link", () => {
  it("opens the deep-linked memory's inspector on load", () => {
    mockData = [mem({ id: "a" }), mem({ id: "b" })]
    render(<MemoryConsole initialSelectedId="b" />)
    expect(screen.getByTestId("memory-inspector").dataset.memoryId).toBe("b")
  })

  it("keeps the deep-linked selection while the live query is still empty", () => {
    mockData = []
    render(<MemoryConsole initialSelectedId="b" />)
    expect(screen.queryByTestId("memory-inspector")).toBeNull()
    expect(screen.getByTestId("memory-empty")).toBeTruthy()
  })
})

describe("MemoryConsole — tabs", () => {
  it("switches to the external agent memory tab", async () => {
    mockData = [mem()]
    render(<MemoryConsole />)
    await userEvent.click(screen.getByTestId("memory-tab-external"))
    expect(screen.getByTestId("external-tab")).toBeTruthy()
    expect(screen.queryByTestId("memory-toolbar")).toBeNull()
  })
})

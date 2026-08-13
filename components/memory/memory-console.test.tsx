/**
 * @jest-environment jsdom
 */
import { render, screen, fireEvent, within, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { Memory } from "@/types/memory/memory"
import type { ManageMemoryResult } from "@/lib/memory/control-plane/manage"

let mockData: Memory[] = []
jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: () => mockData,
}))

// jsdom has no layout, so the real virtualizer would render zero rows. Render
// every item instead — count assertions below stay meaningful.
jest.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({
        index,
        key: index,
        start: index * 104,
        size: 104,
        end: (index + 1) * 104,
        lane: 0,
      })),
    getTotalSize: () => count * 104,
    measureElement: jest.fn(),
  }),
}))

jest.mock("motion/react", () => jest.requireActual("../../__mocks__/motion-react.js"))

const mockToastError = jest.fn()
jest.mock("sonner", () => ({
  toast: { error: (...args: unknown[]) => mockToastError(...args), success: jest.fn() },
}))
// The external tab is exercised by its own suite; stub it here so the console
// tests stay focused on the app-memory tab and don't pull in CodeMirror / fs.
jest.mock("./external/external-memory-tab", () => ({
  ExternalMemoryTab: () => <div data-testid="external-tab" />,
}))
jest.mock("@/components/rag/retrieval-control-panel", () => ({
  RetrievalControlPanel: () => <div data-testid="retrieval-control-panel" />,
}))

// Control the viewport so we can exercise both the desktop resizable pane and
// the narrow sheet. `useResizableLayout` stays real (localStorage-backed).
const mockUseMediaQuery = jest.fn((_q: string) => true)
jest.mock("@/hooks/ui", () => {
  const actual = jest.requireActual("@/hooks/ui")
  return { ...actual, useMediaQuery: (q: string) => mockUseMediaQuery(q) }
})

jest.mock("@/lib/db/memories", () => ({
  listMemories: jest.fn(),
}))
const mockManage = jest.fn<Promise<ManageMemoryResult>, unknown[]>(async (..._args) => ({
  ok: true,
}))
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
  jest.clearAllMocks()
  seq = 0
  mockUseMediaQuery.mockReturnValue(true)
})

describe("MemoryConsole — list & filters", () => {
  it("renders an empty state with an add CTA when there are no memories", () => {
    mockData = []
    render(<MemoryConsole />)
    expect(screen.getByText(/no memories yet/i)).toBeTruthy()
    expect(screen.getByRole("button", { name: /add your first memory/i })).toBeTruthy()
  })

  it("renders a row per active memory", () => {
    mockData = [mem({ text: "prefers pnpm" }), mem({ text: "lives in Shanghai" })]
    render(<MemoryConsole />)
    expect(screen.getAllByTestId("memory-row")).toHaveLength(2)
  })

  it("hides invalidated memories until 'show archived' is toggled", () => {
    mockData = [mem({ id: "a", text: "active one" }), mem({ id: "b", status: "invalidated" })]
    render(<MemoryConsole />)
    expect(screen.getAllByTestId("memory-row")).toHaveLength(1)
    fireEvent.click(screen.getByRole("button", { name: /show archived/i }))
    expect(screen.getAllByTestId("memory-row")).toHaveLength(2)
  })

  it("filters by search query", async () => {
    mockData = [mem({ text: "prefers pnpm" }), mem({ text: "lives in Shanghai" })]
    render(<MemoryConsole />)
    fireEvent.change(screen.getByLabelText(/search memories/i), { target: { value: "pnpm" } })
    await waitFor(() => expect(screen.getAllByTestId("memory-row")).toHaveLength(1))
    expect(within(screen.getAllByTestId("memory-row")[0]).getByText("prefers pnpm")).toBeTruthy()
  })

  it("filters by type via the type chips", () => {
    mockData = [
      mem({ id: "s", type: "semantic", text: "sem" }),
      mem({ id: "e", type: "episodic", text: "epi" }),
    ]
    render(<MemoryConsole />)
    fireEvent.click(screen.getByRole("button", { name: "Event" })) // episodic label
    const rows = screen.getAllByTestId("memory-row")
    expect(rows).toHaveLength(1)
    expect(within(rows[0]).getByText("epi")).toBeTruthy()
  })

  it("filters by scope via the scope select", async () => {
    const user = userEvent.setup()
    mockData = [
      mem({ id: "g", scope: "global", text: "global one" }),
      mem({ id: "c", scope: "character", characterId: "x", text: "character one" }),
    ]
    render(<MemoryConsole />)
    await user.click(screen.getByRole("combobox", { name: "Scope" }))
    await user.click(screen.getByRole("option", { name: "Character" }))
    const rows = screen.getAllByTestId("memory-row")
    expect(rows).toHaveLength(1)
    expect(within(rows[0]).getByText("character one")).toBeTruthy()
  })

  it("filters by provenance via the provenance select", async () => {
    const user = userEvent.setup()
    mockData = [
      mem({ id: "u", provenance: "user", text: "auto one" }),
      mem({ id: "x", provenance: "explicit", text: "explicit one" }),
    ]
    render(<MemoryConsole />)
    await user.click(screen.getByRole("combobox", { name: "Source type" }))
    await user.click(screen.getByRole("option", { name: "Explicit" }))
    const rows = screen.getAllByTestId("memory-row")
    expect(rows).toHaveLength(1)
    expect(within(rows[0]).getByText("explicit one")).toBeTruthy()
  })

  it("filters by clicking a tag chip and clears it again", () => {
    mockData = [
      mem({ id: "a", text: "tagged", tags: ["work"] }),
      mem({ id: "b", text: "untagged" }),
    ]
    render(<MemoryConsole />)
    fireEvent.click(screen.getByRole("button", { name: "#work" }))
    expect(screen.getAllByTestId("memory-row")).toHaveLength(1)
    // Active-tag chip appears; clearing restores the full list.
    fireEvent.click(screen.getByRole("button", { name: /clear tags/i }))
    expect(screen.getAllByTestId("memory-row")).toHaveLength(2)
  })

  it("sorts by recently created", async () => {
    const user = userEvent.setup()
    mockData = [
      mem({ id: "old", text: "old", createdAt: 100, updatedAt: 500 }),
      mem({ id: "new", text: "new", createdAt: 900, updatedAt: 100 }),
    ]
    render(<MemoryConsole />)
    await user.click(screen.getByRole("combobox", { name: "Sort" }))
    await user.click(screen.getByRole("option", { name: /recently created/i }))
    const rows = screen.getAllByTestId("memory-row")
    expect(within(rows[0]).getByText("new")).toBeTruthy()
  })

  it("shows a clearable no-results state when filters match nothing", async () => {
    mockData = [mem({ text: "prefers pnpm" })]
    render(<MemoryConsole />)
    fireEvent.change(screen.getByLabelText(/search memories/i), { target: { value: "zzzz" } })
    await waitFor(() => expect(screen.getByTestId("memory-empty-filtered")).toBeTruthy())
    fireEvent.click(screen.getByRole("button", { name: /clear filters/i }))
    await waitFor(() => expect(screen.getAllByTestId("memory-row")).toHaveLength(1))
  })

  it("shows the active count in the stats", () => {
    mockData = [mem(), mem(), mem({ status: "invalidated" })]
    render(<MemoryConsole />)
    expect(within(screen.getByTestId("memory-stat-active")).getByText("2")).toBeTruthy()
  })
})

describe("MemoryConsole — row & detail", () => {
  it("wires per-row pin/delete to the db helpers", async () => {
    mockData = [mem({ id: "m1", text: "x", pinned: false })]
    render(<MemoryConsole />)
    const row = screen.getByTestId("memory-row")
    fireEvent.click(within(row).getByRole("button", { name: /^pin$/i }))
    expect(mockManage).toHaveBeenCalledWith({ kind: "pin", id: "m1", pinned: true })
    fireEvent.click(within(row).getByRole("button", { name: /delete/i }))
    // Row delete defers behind its fade-out.
    await waitFor(() => expect(mockManage).toHaveBeenCalledWith({ kind: "delete", id: "m1" }))
  })

  it("opens the detail sidebar on row click and navigates through the list", () => {
    mockData = [
      mem({ id: "a", text: "first", updatedAt: 200 }),
      mem({ id: "b", text: "second", updatedAt: 100 }),
    ]
    render(<MemoryConsole />)
    fireEvent.click(screen.getByText("first"))
    const panel = screen.getByTestId("memory-detail-panel")
    expect(within(panel).getByTestId("memory-detail-text").textContent).toBe("first")
    expect(within(panel).getByTestId("memory-detail-nav").textContent).toBe("1/2")
    fireEvent.click(within(panel).getByRole("button", { name: /next memory/i }))
    expect(screen.getByTestId("memory-detail-text").textContent).toBe("second")
  })

  it("saves a detail edit through updateMemory with a version bump", () => {
    mockData = [mem({ id: "m1", text: "before" })]
    render(<MemoryConsole />)
    fireEvent.click(screen.getByText("before"))
    const panel = screen.getByTestId("memory-detail-panel")
    fireEvent.click(within(panel).getByRole("button", { name: "Edit" }))
    fireEvent.change(within(panel).getByLabelText("Text"), { target: { value: "after" } })
    fireEvent.click(within(panel).getByRole("button", { name: "Save" }))
    expect(mockManage).toHaveBeenCalledWith({ kind: "update", id: "m1", patch: { text: "after" } })
  })

  it("lets the user resolve a conflicting memory from the detail panel", () => {
    mockData = [mem({ id: "m1", text: "conflict", reviewStatus: "conflict" })]
    render(<MemoryConsole />)
    fireEvent.click(screen.getByText("conflict"))
    fireEvent.click(screen.getByRole("button", { name: /mark verified/i }))
    expect(mockManage).toHaveBeenCalledWith({ kind: "review", id: "m1", status: "verified" })
  })

  it("renders the detail in a bottom sheet on narrow viewports", () => {
    mockUseMediaQuery.mockReturnValue(false)
    mockData = [mem({ id: "m1", text: "sheeted" })]
    render(<MemoryConsole />)
    fireEvent.click(screen.getByText("sheeted"))
    expect(screen.getByTestId("memory-detail-sheet")).toBeTruthy()
  })

  it("clears the selection when the narrow-viewport sheet closes", async () => {
    const user = userEvent.setup()
    mockUseMediaQuery.mockReturnValue(false)
    mockData = [mem({ id: "m1", text: "sheeted" })]
    render(<MemoryConsole />)
    fireEvent.click(screen.getByText("sheeted"))
    await user.keyboard("{Escape}")
    await waitFor(() => expect(screen.queryByTestId("memory-detail-sheet")).toBeNull())
  })

  it("saves a row's inline edit and toggles selection off again", async () => {
    mockData = [mem({ id: "m1", text: "editable" })]
    render(<MemoryConsole />)
    const row = screen.getByTestId("memory-row")
    // Inline edit through the console wiring.
    fireEvent.click(within(row).getByRole("button", { name: /^edit$/i }))
    fireEvent.change(within(row).getByRole("textbox"), { target: { value: "edited text" } })
    fireEvent.click(within(row).getByRole("button", { name: /save/i }))
    expect(mockManage).toHaveBeenCalledWith({
      kind: "update",
      id: "m1",
      patch: { text: "edited text" },
    })
    // Select, then deselect (checkbox + select-all uncheck paths).
    fireEvent.click(screen.getByTestId("memory-select"))
    fireEvent.click(screen.getByTestId("memory-bulk-select-all"))
    expect(screen.queryByTestId("memory-bulk-toolbar")).toBeNull()
  })

  it("closes the detail pane on Escape", () => {
    mockData = [mem({ id: "m1", text: "closes" })]
    render(<MemoryConsole />)
    fireEvent.click(screen.getByText("closes"))
    expect(screen.getByTestId("memory-detail-panel")).toBeTruthy()
    fireEvent.keyDown(window, { key: "Escape" })
    expect(screen.queryByTestId("memory-detail-panel")).toBeNull()
  })
})

describe("MemoryConsole — add & bulk", () => {
  it("creates a memory through the add dialog with explicit provenance", async () => {
    mockData = []
    render(<MemoryConsole />)
    fireEvent.click(screen.getByTestId("memory-add-button"))
    fireEvent.change(screen.getByLabelText("Memory"), { target: { value: "new fact" } })
    fireEvent.click(screen.getByRole("button", { name: "Add memory" }))
    await waitFor(() => expect(mockManage).toHaveBeenCalled())
    expect(mockManage).toHaveBeenCalledWith({
      kind: "create",
      type: "semantic",
      scope: "global",
      text: "new fact",
      importance: 5,
      tags: [],
    })
  })

  it("bulk-deletes the selected memories after confirmation", () => {
    mockData = [mem({ id: "a" }), mem({ id: "b" })]
    render(<MemoryConsole />)
    const checks = screen.getAllByTestId("memory-select")
    fireEvent.click(checks[0])
    fireEvent.click(checks[1])
    const toolbar = screen.getByTestId("memory-bulk-toolbar")
    expect(within(toolbar).getByTestId("memory-bulk-count").textContent).toContain("2")
    fireEvent.click(within(toolbar).getByRole("button", { name: /^delete$/i }))
    const dialog = screen.getByRole("alertdialog")
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }))
    expect(mockManage).toHaveBeenCalledWith({ kind: "delete", id: "a" })
    expect(mockManage).toHaveBeenCalledWith({ kind: "delete", id: "b" })
  })

  it("bulk-pins the selection", () => {
    mockData = [mem({ id: "a" })]
    render(<MemoryConsole />)
    fireEvent.click(screen.getByTestId("memory-select"))
    const toolbar = screen.getByTestId("memory-bulk-toolbar")
    fireEvent.click(within(toolbar).getByRole("button", { name: /^pin$/i }))
    expect(mockManage).toHaveBeenCalledWith({ kind: "pin", id: "a", pinned: true })
  })

  it("select-all toggles every visible row", () => {
    mockData = [mem({ id: "a" }), mem({ id: "b" })]
    render(<MemoryConsole />)
    fireEvent.click(screen.getAllByTestId("memory-select")[0])
    fireEvent.click(screen.getByTestId("memory-bulk-select-all"))
    const toolbar = screen.getByTestId("memory-bulk-toolbar")
    expect(within(toolbar).getByTestId("memory-bulk-count").textContent).toContain("2")
  })
})

describe("MemoryConsole — mutation feedback", () => {
  it("surfaces a toast when a mutation is rejected", async () => {
    mockManage.mockResolvedValueOnce({ ok: false, reason: "disabled" })
    mockData = [mem({ id: "m1", text: "x" })]
    render(<MemoryConsole />)
    fireEvent.click(
      within(screen.getByTestId("memory-row")).getByRole("button", { name: /^pin$/i })
    )
    await waitFor(() =>
      expect(mockToastError).toHaveBeenCalledWith("Memory is disabled in settings")
    )
  })

  it("surfaces a generic toast when a mutation throws", async () => {
    mockManage.mockRejectedValueOnce(new Error("boom"))
    mockData = [mem({ id: "m1", text: "x" })]
    render(<MemoryConsole />)
    fireEvent.click(
      within(screen.getByTestId("memory-row")).getByRole("button", { name: /^pin$/i })
    )
    await waitFor(() =>
      expect(mockToastError).toHaveBeenCalledWith("The memory operation failed — please try again")
    )
  })
})

describe("MemoryConsole — conflict flow", () => {
  const conflictPair = () => [
    mem({ id: "c1", text: "uses npm", reviewStatus: "conflict", conflictWithIds: ["c2"] }),
    mem({ id: "c2", text: "uses pnpm", reviewStatus: "conflict", conflictWithIds: ["c1"] }),
    mem({ id: "ok", text: "unrelated fact" }),
  ]

  it("counts pending conflicts and toggles the preset filter", () => {
    mockData = conflictPair()
    render(<MemoryConsole />)
    const card = screen.getByTestId("memory-stat-conflicts")
    expect(within(card).getByText("2")).toBeTruthy()
    fireEvent.click(card)
    expect(screen.getAllByTestId("memory-row")).toHaveLength(2)
    fireEvent.click(card)
    expect(screen.getAllByTestId("memory-row")).toHaveLength(3)
  })

  it("opens the resolver from the detail panel and resolves keep-this", async () => {
    const user = userEvent.setup()
    mockData = conflictPair()
    render(<MemoryConsole />)
    // Open the conflicting row's detail, then the guided resolver.
    await user.click(within(screen.getAllByTestId("memory-row")[0]).getByText("uses npm"))
    await user.click(await screen.findByTestId("memory-detail-open-resolver"))
    const dialog = await screen.findByTestId("memory-conflict-resolver")
    expect(within(dialog).getByText("uses npm")).toBeTruthy()
    expect(within(dialog).getByText("uses pnpm")).toBeTruthy()
    await user.click(
      within(within(dialog).getByTestId("conflict-side-c1")).getByRole("button", {
        name: "Keep this one",
      })
    )
    expect(mockManage).toHaveBeenCalledWith({
      kind: "resolve-conflict",
      keepId: "c1",
      dropId: "c2",
      mode: "keep",
    })
  })
})

describe("MemoryConsole — keyboard navigation", () => {
  it("steps the detail selection with arrows and closes with Escape", async () => {
    mockData = [
      mem({ id: "a", text: "first", updatedAt: 200 }),
      mem({ id: "b", text: "second", updatedAt: 100 }),
    ]
    render(<MemoryConsole />)
    fireEvent.click(screen.getByText("first"))
    const panel = screen.getByTestId("memory-detail-panel")
    expect(within(panel).getByTestId("memory-detail-text").textContent).toBe("first")

    fireEvent.keyDown(window, { key: "ArrowDown" })
    expect(
      within(screen.getByTestId("memory-detail-panel")).getByTestId("memory-detail-text")
        .textContent
    ).toBe("second")
    fireEvent.keyDown(window, { key: "ArrowUp" })
    expect(
      within(screen.getByTestId("memory-detail-panel")).getByTestId("memory-detail-text")
        .textContent
    ).toBe("first")
    fireEvent.keyDown(window, { key: "Escape" })
    expect(screen.queryByTestId("memory-detail-panel")).toBeNull()
  })

  it("ignores navigation keys while typing in an input", () => {
    mockData = [mem({ id: "a", text: "first" }), mem({ id: "b", text: "second" })]
    render(<MemoryConsole />)
    fireEvent.click(screen.getByText("first"))
    const search = screen.getByLabelText(/search memories/i)
    fireEvent.keyDown(search, { key: "Escape" })
    expect(screen.getByTestId("memory-detail-panel")).toBeInTheDocument()
  })
})

describe("MemoryConsole — deep link", () => {
  it("opens the deep-linked memory's detail on load", () => {
    mockData = [mem({ id: "target", text: "deep linked" }), mem({ id: "other", text: "other" })]
    render(<MemoryConsole initialSelectedId="target" />)
    const panel = screen.getByTestId("memory-detail-panel")
    expect(within(panel).getByTestId("memory-detail-text").textContent).toBe("deep linked")
  })

  it("keeps the deep-linked selection while the live query is still empty", () => {
    mockData = []
    render(<MemoryConsole initialSelectedId="target" />)
    // No detail (row not loaded yet), but the selection was not nulled — the
    // empty-store guard only clears once real rows exist without a match.
    expect(screen.queryByTestId("memory-detail-panel")).toBeNull()
  })
})

describe("MemoryConsole — tabs", () => {
  it("exposes the external agent memory tab", async () => {
    mockData = []
    const user = userEvent.setup()
    render(<MemoryConsole />)
    await user.click(screen.getByRole("tab", { name: /external agent memory/i }))
    expect(await screen.findByTestId("external-tab")).toBeTruthy()
  })
})

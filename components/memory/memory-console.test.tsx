/**
 * @jest-environment jsdom
 */
import { render, screen, fireEvent, within, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { Memory } from "@/types/memory/memory"

let mockData: Memory[] = []
jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: () => mockData,
}))
// The external tab is exercised by its own suite; stub it here so the console
// tests stay focused on the app-memory tab and don't pull in CodeMirror / fs.
jest.mock("./external/external-memory-tab", () => ({
  ExternalMemoryTab: () => <div data-testid="external-tab" />,
}))

// Control the viewport so we can exercise both the desktop resizable pane and
// the narrow sheet. `useResizableLayout` stays real (localStorage-backed).
const mockUseMediaQuery = jest.fn((_q: string) => true)
jest.mock("@/hooks/ui", () => {
  const actual = jest.requireActual("@/hooks/ui")
  return { ...actual, useMediaQuery: (q: string) => mockUseMediaQuery(q) }
})

const mockSetPinned = jest.fn()
const mockSetManyPinned = jest.fn()
const mockUpdate = jest.fn()
const mockDelete = jest.fn()
const mockDeleteMany = jest.fn()
const mockCreate = jest.fn()
jest.mock("@/lib/db/memories", () => ({
  listMemories: jest.fn(),
  setMemoryPinned: (...a: unknown[]) => mockSetPinned(...a),
  setMemoriesPinned: (...a: unknown[]) => mockSetManyPinned(...a),
  updateMemory: (...a: unknown[]) => mockUpdate(...a),
  hardDeleteMemory: (...a: unknown[]) => mockDelete(...a),
  hardDeleteMemories: (...a: unknown[]) => mockDeleteMany(...a),
  createMemory: (...a: unknown[]) => mockCreate(...a),
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
  it("wires per-row pin/delete to the db helpers", () => {
    mockData = [mem({ id: "m1", text: "x", pinned: false })]
    render(<MemoryConsole />)
    const row = screen.getByTestId("memory-row")
    fireEvent.click(within(row).getByRole("button", { name: /^pin$/i }))
    expect(mockSetPinned).toHaveBeenCalledWith("m1", true)
    fireEvent.click(within(row).getByRole("button", { name: /delete/i }))
    expect(mockDelete).toHaveBeenCalledWith("m1")
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
    expect(mockUpdate).toHaveBeenCalledWith("m1", { text: "after", bumpVersion: true })
  })

  it("renders the detail in a bottom sheet on narrow viewports", () => {
    mockUseMediaQuery.mockReturnValue(false)
    mockData = [mem({ id: "m1", text: "sheeted" })]
    render(<MemoryConsole />)
    fireEvent.click(screen.getByText("sheeted"))
    expect(screen.getByTestId("memory-detail-sheet")).toBeTruthy()
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
    await waitFor(() => expect(mockCreate).toHaveBeenCalled())
    expect(mockCreate).toHaveBeenCalledWith({
      scope: "global",
      type: "semantic",
      text: "new fact",
      importance: 5,
      tags: [],
      provenance: "explicit",
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
    expect(mockDeleteMany).toHaveBeenCalledWith(["a", "b"])
  })

  it("bulk-pins the selection", () => {
    mockData = [mem({ id: "a" })]
    render(<MemoryConsole />)
    fireEvent.click(screen.getByTestId("memory-select"))
    const toolbar = screen.getByTestId("memory-bulk-toolbar")
    fireEvent.click(within(toolbar).getByRole("button", { name: /^pin$/i }))
    expect(mockSetManyPinned).toHaveBeenCalledWith(["a"], true)
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

describe("MemoryConsole — tabs", () => {
  it("exposes the external agent memory tab", async () => {
    mockData = []
    const user = userEvent.setup()
    render(<MemoryConsole />)
    await user.click(screen.getByRole("tab", { name: /external agent memory/i }))
    expect(await screen.findByTestId("external-tab")).toBeTruthy()
  })
})

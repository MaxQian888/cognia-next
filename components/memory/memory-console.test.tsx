/**
 * @jest-environment jsdom
 */
import { render, screen, fireEvent, within } from "@testing-library/react"
import type { Memory } from "@/types/memory/memory"

let mockData: Memory[] = []
jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: () => mockData,
}))
const mockSetPinned = jest.fn()
const mockUpdate = jest.fn()
const mockDelete = jest.fn()
jest.mock("@/lib/db/memories", () => ({
  listMemories: jest.fn(),
  setMemoryPinned: (...a: unknown[]) => mockSetPinned(...a),
  updateMemory: (...a: unknown[]) => mockUpdate(...a),
  hardDeleteMemory: (...a: unknown[]) => mockDelete(...a),
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
})

describe("MemoryConsole", () => {
  it("renders an empty state when there are no memories", () => {
    mockData = []
    render(<MemoryConsole />)
    expect(screen.getByText(/no memories yet/i)).toBeTruthy()
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

  it("filters by search query", () => {
    mockData = [mem({ text: "prefers pnpm" }), mem({ text: "lives in Shanghai" })]
    render(<MemoryConsole />)
    fireEvent.change(screen.getByLabelText(/search memories/i), { target: { value: "pnpm" } })
    const rows = screen.getAllByTestId("memory-row")
    expect(rows).toHaveLength(1)
    expect(within(rows[0]).getByText("prefers pnpm")).toBeTruthy()
  })

  it("filters by type via the type chips", () => {
    mockData = [
      mem({ id: "s", type: "semantic", text: "sem" }),
      mem({ id: "e", type: "episodic", text: "epi" }),
    ]
    render(<MemoryConsole />)
    // "Event" is the episodic label
    fireEvent.click(screen.getByRole("button", { name: "Event" }))
    const rows = screen.getAllByTestId("memory-row")
    expect(rows).toHaveLength(1)
    expect(within(rows[0]).getByText("epi")).toBeTruthy()
  })

  it("wires row actions to the db helpers", () => {
    mockData = [mem({ id: "m1", text: "x", pinned: false })]
    render(<MemoryConsole />)
    fireEvent.click(screen.getByRole("button", { name: /^pin$/i }))
    expect(mockSetPinned).toHaveBeenCalledWith("m1", true)
    fireEvent.click(screen.getByRole("button", { name: /delete/i }))
    expect(mockDelete).toHaveBeenCalledWith("m1")
  })

  it("shows active count in the stats", () => {
    mockData = [mem(), mem(), mem({ status: "invalidated" })]
    render(<MemoryConsole />)
    // 2 active of 3 total
    expect(within(screen.getByTestId("memory-stat-active")).getByText("2")).toBeTruthy()
  })
})

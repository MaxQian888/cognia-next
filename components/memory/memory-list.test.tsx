/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"
import type { Memory } from "@/types/memory/memory"
import { MemoryList } from "./memory-list"

const scrollToIndex = jest.fn()
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
    scrollToIndex: (...args: unknown[]) => scrollToIndex(...args),
  }),
}))

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

function setup(over: Partial<Parameters<typeof MemoryList>[0]> = {}) {
  const onClearFilters = jest.fn()
  const onAddFirst = jest.fn()
  render(
    <MemoryList
      rows={[]}
      isLoading={false}
      hasAnyMemories={false}
      selectedIds={new Set()}
      selectionActive={false}
      onOpenDetail={jest.fn()}
      onSelectToggle={jest.fn()}
      onPinToggle={jest.fn()}
      onSave={jest.fn()}
      onArchive={jest.fn()}
      onDelete={jest.fn()}
      onTagClick={jest.fn()}
      onClearFilters={onClearFilters}
      onAddFirst={onAddFirst}
      {...over}
    />
  )
  return { onClearFilters, onAddFirst }
}

beforeEach(() => {
  seq = 0
  scrollToIndex.mockClear()
})

describe("MemoryList", () => {
  // Collapsing "loading" into "empty" flashes an onboarding CTA on every visit
  // before the Dexie read resolves.
  it("shows skeletons while loading, never an empty state", () => {
    setup({ isLoading: true })
    expect(screen.getByTestId("memory-list-loading")).toBeTruthy()
    expect(screen.queryByTestId("memory-empty")).toBeNull()
    expect(screen.queryByTestId("memory-empty-filtered")).toBeNull()
  })

  it("offers an add CTA when the store is genuinely empty", () => {
    setup({ hasAnyMemories: false })
    expect(screen.getByTestId("memory-empty")).toBeTruthy()
    expect(screen.getByText("No memories yet")).toBeTruthy()
    expect(screen.queryByTestId("memory-empty-filtered")).toBeNull()
  })

  // Inviting someone with 300 memories to "add your first memory" because a
  // filter matched nothing is the wrong offer.
  it("offers a filter reset when the store has rows but the filter matched none", () => {
    setup({ hasAnyMemories: true })
    expect(screen.getByTestId("memory-empty-filtered")).toBeTruthy()
    expect(screen.getByText("No matching memories")).toBeTruthy()
    expect(screen.queryByTestId("memory-empty")).toBeNull()
  })

  it("renders a row per memory", () => {
    setup({ rows: [mem(), mem()], hasAnyMemories: true })
    expect(screen.getAllByTestId("memory-row")).toHaveLength(2)
  })

  it("marks the selected row as active", () => {
    setup({ rows: [mem({ id: "a" }), mem({ id: "b" })], hasAnyMemories: true, selectedId: "b" })
    const rows = screen.getAllByTestId("memory-row")
    expect(rows[0]?.dataset.active).toBeUndefined()
    expect(rows[1]?.dataset.active).toBe("true")
  })

  it("scrolls a deep-linked row into view exactly once", () => {
    const rows = [mem({ id: "a" }), mem({ id: "b" })]
    const { rerender } = render(
      <MemoryList
        rows={rows}
        isLoading={false}
        hasAnyMemories
        selectedIds={new Set()}
        selectionActive={false}
        scrollToId="b"
        onOpenDetail={jest.fn()}
        onSelectToggle={jest.fn()}
        onPinToggle={jest.fn()}
        onSave={jest.fn()}
        onArchive={jest.fn()}
        onDelete={jest.fn()}
        onTagClick={jest.fn()}
        onClearFilters={jest.fn()}
        onAddFirst={jest.fn()}
      />
    )
    expect(scrollToIndex).toHaveBeenCalledWith(1, { align: "center" })
    rerender(
      <MemoryList
        rows={rows}
        isLoading={false}
        hasAnyMemories
        selectedIds={new Set()}
        selectionActive={false}
        scrollToId="b"
        onOpenDetail={jest.fn()}
        onSelectToggle={jest.fn()}
        onPinToggle={jest.fn()}
        onSave={jest.fn()}
        onArchive={jest.fn()}
        onDelete={jest.fn()}
        onTagClick={jest.fn()}
        onClearFilters={jest.fn()}
        onAddFirst={jest.fn()}
      />
    )
    expect(scrollToIndex).toHaveBeenCalledTimes(1)
  })

  it("passes the density down to its rows", () => {
    setup({ rows: [mem()], hasAnyMemories: true, density: "compact" })
    expect(screen.getByTestId("memory-row").dataset.density).toBe("compact")
  })
})

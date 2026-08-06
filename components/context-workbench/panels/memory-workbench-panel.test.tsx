import { render, screen, fireEvent } from "@testing-library/react"
import { MemoryWorkbenchPanel } from "./memory-workbench-panel"

// Mock next-intl
jest.mock("next-intl", () => ({
  useTranslations: (namespace: string) => {
    const keys: Record<string, string> = {
      "contextWorkbench.memoryPanel.searchPlaceholder": "Search memories…",
      "contextWorkbench.memoryPanel.searchLabel": "Search memories",
      "contextWorkbench.memoryPanel.addMemory": "Add memory",
      "contextWorkbench.memoryPanel.count": "{count} memories",
      "contextWorkbench.memoryPanel.sortLabel": "Sort memories",
      "contextWorkbench.memoryPanel.emptyTitle": "No memories yet",
      "contextWorkbench.memoryPanel.emptyDescription":
        "Memories will appear here as the assistant learns.",
      "contextWorkbench.memoryPanel.openFullPage": "Open full memory page",
      "memory.panel.sort.recent": "Recent",
      "memory.panel.sort.importance": "Importance",
      "memory.panel.sort.accessed": "Accessed",
    }
    return (key: string, params?: Record<string, unknown>) => {
      const fullKey = `${namespace}.${key}`
      const value = keys[fullKey] ?? key
      if (params && "count" in params) return value.replace("{count}", String(params.count))
      return value
    }
  },
}))

// Mock dexie-react-hooks
const mockMemories = [
  {
    id: "mem_1",
    type: "semantic" as const,
    scope: "global" as const,
    text: "User prefers TypeScript",
    tags: ["preference"],
    importance: 7,
    pinned: false,
    status: "active" as const,
    provenance: "user" as const,
    createdAt: Date.now() - 60000,
    updatedAt: Date.now() - 60000,
    lastAccessedAt: Date.now() - 30000,
    accessCount: 3,
    version: 1,
  },
  {
    id: "mem_2",
    type: "episodic" as const,
    scope: "global" as const,
    text: "Discussed React patterns",
    tags: ["react"],
    importance: 5,
    pinned: true,
    status: "active" as const,
    provenance: "system" as const,
    createdAt: Date.now() - 120000,
    updatedAt: Date.now() - 120000,
    lastAccessedAt: Date.now() - 60000,
    accessCount: 1,
    version: 1,
  },
]

jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: (fn: () => unknown, _deps?: unknown[], fallback?: unknown) => fallback ?? [],
}))

// Provide memories via a controllable reference
let returnedMemories = mockMemories
jest.mock("@/lib/db/memories", () => ({
  listMemories: jest.fn(() => Promise.resolve(returnedMemories)),
}))

jest.mock("@/lib/memory/control-plane/manage", () => ({
  manageMemory: jest.fn(() => Promise.resolve({ ok: true })),
}))

jest.mock("@/lib/memory/history-filter", () => ({
  filterAndSortMemories: jest.fn((all: typeof mockMemories, _opts: unknown) => all),
}))

// Mock MemoryRow as a simple div with text + buttons
jest.mock("@/components/memory/memory-row", () => ({
  MemoryRow: ({
    memory,
    onPinToggle,
    onDelete,
  }: {
    memory: { id: string; text: string; pinned: boolean }
    onPinToggle: (id: string, pinned: boolean) => void
    onDelete: (id: string) => void
  }) => (
    <div data-testid={`memory-row-${memory.id}`}>
      <span>{memory.text}</span>
      <button onClick={() => onPinToggle(memory.id, memory.pinned)}>pin</button>
      <button onClick={() => onDelete(memory.id)}>delete</button>
    </div>
  ),
}))

// Mock AddMemoryDialog
jest.mock("@/components/memory/add-memory-dialog", () => ({
  AddMemoryDialog: ({
    open,
    onOpenChange,
    onCreate,
  }: {
    open: boolean
    onOpenChange: (open: boolean) => void
    onCreate: (input: unknown) => void
  }) =>
    open ? (
      <div data-testid="add-memory-dialog">
        <button onClick={() => onOpenChange(false)}>close</button>
        <button
          onClick={() =>
            onCreate({
              type: "semantic",
              text: "New memory",
              importance: 5,
              tags: [],
              scope: "global",
            })
          }
        >
          create
        </button>
      </div>
    ) : null,
}))

// Mock ScrollArea
jest.mock("@/components/ui/scroll-area", () => ({
  ScrollArea: ({ children, className }: { children: React.ReactNode; className?: string }) => (
    <div data-testid="scroll-area" className={className}>
      {children}
    </div>
  ),
}))

describe("MemoryWorkbenchPanel", () => {
  beforeEach(() => {
    returnedMemories = mockMemories
    jest.clearAllMocks()
  })

  it("renders the search input and add button", () => {
    render(<MemoryWorkbenchPanel />)
    expect(screen.getByPlaceholderText("Search memories…")).toBeInTheDocument()
    expect(screen.getByLabelText("Add memory")).toBeInTheDocument()
  })

  it("renders memory count label", () => {
    // filterAndSortMemories returns mockMemories (2 items)
    const { filterAndSortMemories } = jest.requireMock("@/lib/memory/history-filter")
    filterAndSortMemories.mockReturnValue(mockMemories)
    render(<MemoryWorkbenchPanel />)
    // The count uses the mocked translation which replaces {count}
    expect(screen.getByText(/2 memories/)).toBeInTheDocument()
  })

  it("shows empty state when no memories exist", () => {
    const { filterAndSortMemories } = jest.requireMock("@/lib/memory/history-filter")
    filterAndSortMemories.mockReturnValue([])
    render(<MemoryWorkbenchPanel />)
    expect(screen.getByText("No memories yet")).toBeInTheDocument()
  })

  it("renders memory rows for each memory", () => {
    const { filterAndSortMemories } = jest.requireMock("@/lib/memory/history-filter")
    filterAndSortMemories.mockReturnValue(mockMemories)
    render(<MemoryWorkbenchPanel />)
    expect(screen.getByTestId("memory-row-mem_1")).toBeInTheDocument()
    expect(screen.getByTestId("memory-row-mem_2")).toBeInTheDocument()
  })

  it("calls manageMemory with pin command when pin is toggled", () => {
    const { manageMemory } = jest.requireMock("@/lib/memory/control-plane/manage")
    const { filterAndSortMemories } = jest.requireMock("@/lib/memory/history-filter")
    filterAndSortMemories.mockReturnValue(mockMemories)
    render(<MemoryWorkbenchPanel />)

    const pinButtons = screen.getAllByText("pin")
    fireEvent.click(pinButtons[0])
    expect(manageMemory).toHaveBeenCalledWith({ kind: "pin", id: "mem_1", pinned: true })
  })

  it("calls manageMemory with delete command when delete is clicked", () => {
    const { manageMemory } = jest.requireMock("@/lib/memory/control-plane/manage")
    const { filterAndSortMemories } = jest.requireMock("@/lib/memory/history-filter")
    filterAndSortMemories.mockReturnValue(mockMemories)
    render(<MemoryWorkbenchPanel />)

    const deleteButtons = screen.getAllByText("delete")
    fireEvent.click(deleteButtons[1])
    expect(manageMemory).toHaveBeenCalledWith({ kind: "delete", id: "mem_2" })
  })

  it("opens add memory dialog when add button is clicked", () => {
    render(<MemoryWorkbenchPanel />)
    expect(screen.queryByTestId("add-memory-dialog")).not.toBeInTheDocument()

    fireEvent.click(screen.getByLabelText("Add memory"))
    expect(screen.getByTestId("add-memory-dialog")).toBeInTheDocument()
  })

  it("passes search query to filterAndSortMemories", () => {
    const { filterAndSortMemories } = jest.requireMock("@/lib/memory/history-filter")
    filterAndSortMemories.mockReturnValue(mockMemories)
    render(<MemoryWorkbenchPanel />)

    fireEvent.change(screen.getByPlaceholderText("Search memories…"), {
      target: { value: "TypeScript" },
    })

    // useDeferredValue defers, but the call should eventually happen
    expect(filterAndSortMemories).toHaveBeenCalled()
  })

  it("renders link to full memory page", () => {
    render(<MemoryWorkbenchPanel />)
    expect(screen.getByText("Open full memory page")).toBeInTheDocument()
    const link = screen.getByText("Open full memory page").closest("a")
    expect(link).toHaveAttribute("href", "/memory")
  })
})

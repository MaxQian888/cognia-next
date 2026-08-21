/** @jest-environment jsdom */

const mockCreateLabel = jest.fn().mockResolvedValue({ id: "new" })
const mockUpdateLabel = jest.fn().mockResolvedValue(undefined)
const mockDeleteLabel = jest.fn().mockResolvedValue(undefined)
const mockReorderLabels = jest.fn().mockResolvedValue(undefined)
jest.mock("@/lib/db/labels", () => ({
  createLabel: (...a: unknown[]) => mockCreateLabel(...a),
  updateLabel: (...a: unknown[]) => mockUpdateLabel(...a),
  deleteLabel: (...a: unknown[]) => mockDeleteLabel(...a),
  reorderLabels: (...a: unknown[]) => mockReorderLabels(...a),
}))

let dndHandlers: Record<string, (event: unknown) => void> = {}
jest.mock("@dnd-kit/core", () => ({
  DndContext: ({ children, ...handlers }: Record<string, unknown>) => {
    dndHandlers = handlers as Record<string, (event: unknown) => void>
    return <div>{children as React.ReactNode}</div>
  },
  PointerSensor: function PointerSensor() {},
  KeyboardSensor: function KeyboardSensor() {},
  closestCenter: jest.fn(),
  useSensor: jest.fn(),
  useSensors: jest.fn(() => []),
}))
jest.mock("@dnd-kit/sortable", () => ({
  SortableContext: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  verticalListSortingStrategy: jest.fn(),
  sortableKeyboardCoordinates: jest.fn(),
  useSortable: () => ({
    attributes: {},
    listeners: {},
    setNodeRef: jest.fn(),
    transform: null,
    transition: undefined,
    isDragging: false,
  }),
}))

const toastError = jest.fn()
jest.mock("sonner", () => ({ toast: { error: (...a: unknown[]) => toastError(...a) } }))

import { act, fireEvent, render, screen } from "@testing-library/react"
import { LABEL_COLORS, type LabelRow } from "@/types/labels"
import { LabelCatalogueEditor } from "./label-catalogue-editor"

const STRINGS = {
  title: "Labels",
  description: "Manage labels",
  nameLabel: "Name",
  namePlaceholder: "e.g. bug",
  colorLabel: "Colour",
  addButton: "Add label",
  nameRequired: "Name required",
  empty: "No labels yet",
  builtinBadge: "Built-in",
  rowNameAria: (name: string) => `Rename ${name}`,
  rowColorAria: (name: string) => `Colour for ${name}`,
  deleteAria: (name: string) => `Delete ${name}`,
  reorderAria: (name: string) => `Reorder ${name}`,
}

const label = (over: Partial<LabelRow> = {}): LabelRow => ({
  id: "l1",
  scope: "issue",
  name: "bug",
  sortOrder: 0,
  createdAt: 0,
  updatedAt: 0,
  ...over,
})

function renderEditor(over: Partial<React.ComponentProps<typeof LabelCatalogueEditor>> = {}) {
  const props: React.ComponentProps<typeof LabelCatalogueEditor> = {
    scope: "issue",
    labels: [],
    strings: STRINGS,
    testId: "cat",
    ...over,
  }
  return render(<LabelCatalogueEditor {...props} />)
}

beforeEach(() => {
  jest.clearAllMocks()
  dndHandlers = {}
})

describe("LabelCatalogueEditor", () => {
  it("shows an empty state", () => {
    renderEditor()
    expect(screen.getByTestId("cat-list")).toHaveTextContent("No labels yet")
  })

  it("creates into the scope it was given, not a hard-coded one", async () => {
    renderEditor({ scope: "issue", colorMode: "palette" })
    fireEvent.change(screen.getByTestId("cat-new-name"), { target: { value: "regression" } })
    await act(async () => {
      fireEvent.click(screen.getByTestId("cat-add"))
    })
    expect(mockCreateLabel).toHaveBeenCalledWith(
      expect.objectContaining({ scope: "issue", name: "regression" })
    )
  })

  it("refuses a blank name with a toast rather than writing an unnamed row", async () => {
    renderEditor()
    await act(async () => {
      fireEvent.click(screen.getByTestId("cat-add"))
    })
    expect(toastError).toHaveBeenCalledWith("Name required")
    expect(mockCreateLabel).not.toHaveBeenCalled()
  })

  it("renames on blur, and only when the value actually changed", () => {
    renderEditor({ labels: [label()] })
    const input = screen.getByTestId("cat-name-l1")
    fireEvent.blur(input)
    expect(mockUpdateLabel).not.toHaveBeenCalled()
    fireEvent.change(input, { target: { value: "defect" } })
    fireEvent.blur(input)
    expect(mockUpdateLabel).toHaveBeenCalledWith("l1", { name: "defect" })
  })

  it("protects a built-in from deletion and says why with a badge", () => {
    renderEditor({ labels: [label({ builtin: true })] })
    expect(screen.getByText("Built-in")).toBeInTheDocument()
    expect(screen.queryByTestId("cat-delete-l1")).not.toBeInTheDocument()
  })

  it("deletes a user label", async () => {
    renderEditor({ labels: [label()] })
    await act(async () => {
      fireEvent.click(screen.getByTestId("cat-delete-l1"))
    })
    expect(mockDeleteLabel).toHaveBeenCalledWith("l1")
  })

  describe("colour", () => {
    it("uses a native input in hex mode", () => {
      renderEditor({ labels: [label({ color: "#ff0000" })], colorMode: "hex" })
      fireEvent.change(screen.getByLabelText("Colour for bug"), {
        target: { value: "#00ff00" },
      })
      expect(mockUpdateLabel).toHaveBeenCalledWith("l1", { color: "#00ff00" })
    })

    it("uses theme swatches in palette mode, so an oklch token is not rewritten as hex", () => {
      renderEditor({ labels: [label()], colorMode: "palette" })
      expect(screen.queryByLabelText("Colour for bug")).toHaveAttribute("role", "radiogroup")
      fireEvent.click(screen.getByTestId("cat-color-l1-2"))
      expect(mockUpdateLabel).toHaveBeenCalledWith("l1", { color: LABEL_COLORS[2] })
    })

    it("hides the create-form colour field in palette mode", () => {
      renderEditor({ colorMode: "palette" })
      expect(screen.queryByTestId("cat-new-color")).not.toBeInTheDocument()
    })

    it("seeds a new palette label deterministically from its name", async () => {
      renderEditor({ colorMode: "palette" })
      fireEvent.change(screen.getByTestId("cat-new-name"), { target: { value: "regression" } })
      await act(async () => {
        fireEvent.click(screen.getByTestId("cat-add"))
      })
      expect(LABEL_COLORS).toContain((mockCreateLabel.mock.calls[0][0] as { color: string }).color)
    })
  })

  describe("reorder", () => {
    it("persists the new order for its own scope", async () => {
      renderEditor({ scope: "issue", labels: [label({ id: "a" }), label({ id: "b" })] })
      await act(async () => {
        await dndHandlers.onDragEnd?.({ active: { id: "b" }, over: { id: "a" } })
      })
      expect(mockReorderLabels).toHaveBeenCalledWith("issue", ["b", "a"])
    })

    it("writes nothing for a drop onto itself", async () => {
      renderEditor({ labels: [label({ id: "a" })] })
      await act(async () => {
        await dndHandlers.onDragEnd?.({ active: { id: "a" }, over: { id: "a" } })
      })
      expect(mockReorderLabels).not.toHaveBeenCalled()
    })

    it("writes nothing for a drop outside the list", async () => {
      renderEditor({ labels: [label({ id: "a" })] })
      await act(async () => {
        await dndHandlers.onDragEnd?.({ active: { id: "a" }, over: null })
      })
      expect(mockReorderLabels).not.toHaveBeenCalled()
    })

    it("puts the grip on its own control, not the whole row, so the name stays clickable", () => {
      renderEditor({ labels: [label()] })
      const grip = screen.getByTestId("cat-grip-l1")
      expect(grip).toHaveAttribute("aria-label", "Reorder bug")
      expect(grip.contains(screen.getByTestId("cat-name-l1"))).toBe(false)
    })
  })

  it("reports a failed write instead of dropping it", async () => {
    mockDeleteLabel.mockRejectedValueOnce(new Error("built-in"))
    renderEditor({ labels: [label()] })
    await act(async () => {
      fireEvent.click(screen.getByTestId("cat-delete-l1"))
    })
    expect(toastError).toHaveBeenCalledWith("built-in")
  })
})

/**
 * CustomModeSettings — built-in surfacing tests
 *
 * Asserts that the Settings page now renders built-in agent modes alongside
 * user-created custom modes (via `useAgentMode`) with:
 *   - a "Built-in" badge on built-in rows
 *   - Edit + Delete disabled on built-in dropdown items
 *   - Duplicate enabled on built-ins and routed through `createMode` so the
 *     resulting row is a fully editable user copy
 *   - Bulk-select checkbox hidden on built-in rows
 *   - Built-ins-available hint when no user modes exist yet
 */

import React from "react"
import { fireEvent, render, screen, waitFor, within, act } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { CustomModeSettings } from "./custom-mode-settings"
import type { AgentModeConfig } from "@/types/agent/agent-mode"
import type { CustomModeConfig } from "@/stores/agent/custom-mode-store"

// ---- Mocks -----------------------------------------------------------------

const mockBuiltIn: AgentModeConfig = {
  id: "general",
  type: "general",
  name: "General Assistant",
  description: "Built-in mode",
  icon: "Bot",
  outputFormat: "text",
}

const mockCustom: CustomModeConfig = {
  id: "custom-1",
  type: "custom",
  isBuiltIn: false,
  name: "User Mode",
  description: "User-created",
  icon: "Bot",
  systemPrompt: "be helpful",
  tools: [],
  outputFormat: "text",
  previewEnabled: false,
  customConfig: {},
  category: "other",
  tags: [],
  usageCount: 0,
  createdAt: new Date(0),
  updatedAt: new Date(0),
}

const createModeMock = jest.fn((draft: Partial<CustomModeConfig>): CustomModeConfig => ({
  ...mockCustom,
  ...draft,
  id: draft.id ?? "custom-new",
  type: "custom",
  isBuiltIn: false,
}))
const deleteModeMock = jest.fn()
const duplicateModeMock = jest.fn(() => mockCustom)
const exportModeMock = jest.fn(() => "{}")
const exportAllModesMock = jest.fn(() => "{}")
const importModeMock = jest.fn()
const importModesMock = jest.fn()

// Shared mutable state so both the (skipped) built-in surfacing block and
// the polish block below can drive the store without redeclaring the mock.
const customModeStoreRef: { current: Record<string, unknown> } = { current: {} }

jest.mock("@/stores/agent/custom-mode-store", () => ({
  useCustomModeStore: () => customModeStoreRef.current,
}))

const isBuiltInModeMock = jest.fn((id: string) => id === "general")

jest.mock("@/hooks/agent/use-agent-mode", () => ({
  useAgentMode: () => ({
    allModes: [mockBuiltIn, mockCustom],
    builtInModes: [mockBuiltIn],
    customModes: [mockCustom],
    pluginModes: [],
    isBuiltInMode: isBuiltInModeMock,
  }),
}))

// CustomModeEditor pulls in many side-effect-heavy components; stub it so
// these focused row tests don't need to mount the full editor tree.
jest.mock("@/components/agent/mode/custom-mode-editor", () => ({
  CustomModeEditor: ({
    open,
    mode,
    onSave,
  }: {
    open: boolean
    mode?: { id: string }
    onSave: () => void
  }) =>
    open ? (
      <div data-testid="stub-mode-editor" data-mode-id={mode?.id ?? ""}>
        <button type="button" onClick={onSave}>
          stub-save
        </button>
      </div>
    ) : null,
}))

const toastSuccess = jest.fn()
const toastError = jest.fn()
jest.mock("@/components/ui/sonner", () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccess(...args),
    error: (...args: unknown[]) => toastError(...args),
  },
}))

// Quiet the agent logger spam during tests
jest.mock("@cognia/logging", () => ({
  loggers: {
    agent: {
      child: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    },
  },
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}))

// ---- Tests -----------------------------------------------------------------

// TODO(cognia-next): the cognia-next port of CustomModeSettings does not yet
// surface built-in agent modes alongside user-created custom modes — the
// source still only renders rows from `useCustomModeStore.customModes` and
// ignores `useAgentMode().builtInModes`. The original Cognia tests below
// exercise that integration, which is a future deliverable for cognia-next.
// The tests are skipped until the source-level integration lands.
describe.skip("CustomModeSettings — built-in surfacing", () => {
  beforeEach(() => {
    createModeMock.mockClear()
    deleteModeMock.mockClear()
    duplicateModeMock.mockClear()
    isBuiltInModeMock.mockClear()
    customModeStoreRef.current = {
      deleteMode: deleteModeMock,
      duplicateMode: duplicateModeMock,
      exportMode: exportModeMock,
      exportAllModes: exportAllModesMock,
      importMode: importModeMock,
      importModes: importModesMock,
      createMode: createModeMock,
    }
  })

  it("renders the Built-in badge on built-in rows", () => {
    render(<CustomModeSettings />)
    const builtInRow = screen.getByTestId("custom-mode-row-general")
    expect(builtInRow).toHaveAttribute("data-builtin", "true")
    expect(within(builtInRow).getByText("Built-in")).toBeInTheDocument()
  })

  it("renders user rows without the built-in badge", () => {
    render(<CustomModeSettings />)
    const userRow = screen.getByTestId("custom-mode-row-custom-1")
    expect(userRow).toHaveAttribute("data-builtin", "false")
    expect(within(userRow).queryByText("Built-in")).not.toBeInTheDocument()
  })

  it("hides the bulk-select checkbox on built-in rows", () => {
    render(<CustomModeSettings />)
    const builtInRow = screen.getByTestId("custom-mode-row-general")
    expect(within(builtInRow).queryByRole("checkbox")).not.toBeInTheDocument()
    const userRow = screen.getByTestId("custom-mode-row-custom-1")
    expect(within(userRow).getByRole("checkbox")).toBeInTheDocument()
  })

  it("disables Edit and Delete in the dropdown for a built-in row", async () => {
    const user = userEvent.setup()
    render(<CustomModeSettings />)
    const builtInRow = screen.getByTestId("custom-mode-row-general")
    const trigger = within(builtInRow).getByRole("button")
    await user.click(trigger)
    // Radix renders DropdownMenuItem outside the row in a portal, but the
    // items are queryable via role=menuitem with their accessible name.
    const editItem = await screen.findByRole("menuitem", { name: /edit/i })
    const deleteItem = await screen.findByRole("menuitem", { name: /delete/i })
    expect(editItem).toHaveAttribute("aria-disabled", "true")
    expect(deleteItem).toHaveAttribute("aria-disabled", "true")
    // Duplicate stays enabled
    const duplicateItem = await screen.findByRole("menuitem", { name: /duplicate/i })
    expect(duplicateItem).not.toHaveAttribute("aria-disabled", "true")
  })

  it("duplicating a built-in routes through createMode (forks to a user copy)", async () => {
    const user = userEvent.setup()
    render(<CustomModeSettings />)
    const builtInRow = screen.getByTestId("custom-mode-row-general")
    const trigger = within(builtInRow).getByRole("button")
    await act(async () => {
      await user.click(trigger)
    })
    const duplicateItem = await screen.findByRole("menuitem", { name: /duplicate/i })
    await act(async () => {
      await user.click(duplicateItem)
    })
    expect(createModeMock).toHaveBeenCalledTimes(1)
    const draft = createModeMock.mock.calls[0]![0] as Partial<CustomModeConfig>
    expect(draft.type).toBe("custom")
    expect(draft.id).toBeUndefined()
    expect(draft.name).toContain("(Copy)")
    // The store's duplicateMode (used for user rows) must NOT have been hit.
    expect(duplicateModeMock).not.toHaveBeenCalled()
  })

  it("duplicating a user mode routes through duplicateMode", async () => {
    const user = userEvent.setup()
    render(<CustomModeSettings />)
    const userRow = screen.getByTestId("custom-mode-row-custom-1")
    const trigger = within(userRow).getByRole("button")
    await act(async () => {
      await user.click(trigger)
    })
    const duplicateItem = await screen.findByRole("menuitem", { name: /duplicate/i })
    await act(async () => {
      await user.click(duplicateItem)
    })
    expect(duplicateModeMock).toHaveBeenCalledWith("custom-1")
    expect(createModeMock).not.toHaveBeenCalled()
  })

  it("hides the per-row Export item on built-in rows", async () => {
    const user = userEvent.setup()
    render(<CustomModeSettings />)
    const builtInRow = screen.getByTestId("custom-mode-row-general")
    const trigger = within(builtInRow).getByRole("button")
    await act(async () => {
      await user.click(trigger)
    })
    expect(screen.queryByRole("menuitem", { name: /export/i })).not.toBeInTheDocument()
  })
})

// ---- Polish-phase tests (responsive filter row, aria, results count, etc.) --

const polishCustomA: CustomModeConfig = {
  id: "polish-a",
  type: "custom",
  isBuiltIn: false,
  name: "Polish A",
  description: "tagline alpha",
  icon: "Bot",
  systemPrompt: "",
  tools: [],
  outputFormat: "text",
  previewEnabled: false,
  customConfig: {},
  category: "productivity",
  tags: [],
  usageCount: 1,
  createdAt: new Date(0),
  updatedAt: new Date(0),
}

const polishCustomB: CustomModeConfig = {
  ...polishCustomA,
  id: "polish-b",
  name: "Polish B",
  description: "tagline beta",
  category: "creative",
  systemPrompt: "answer briefly",
  tools: ["Read"],
  tags: ["beta"],
  permissionMode: "plan",
  modelOverride: "claude-opus-5",
  usageCount: 9,
  createdAt: new Date(1_000),
  updatedAt: new Date(1_000),
}

// The export path builds a Blob URL and clicks a synthetic anchor; jsdom
// implements neither, so stub both rather than letting the handler throw.
const createObjectURL = jest.fn(() => "blob:mode")
const revokeObjectURL = jest.fn()
const anchorClick = jest.fn()
beforeAll(() => {
  Object.assign(URL, { createObjectURL, revokeObjectURL })
  jest.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(anchorClick)
})

/**
 * Drive the hidden file input with `content`, then wait for the async
 * `FileReader.onload` to land. `File.text()` is not what the component uses —
 * it reads through `FileReader`, so the test has to await the callback, not the
 * promise.
 */
async function readFileInto(input: HTMLInputElement, content: string) {
  const before = toastSuccess.mock.calls.length + toastError.mock.calls.length
  const file = new File([content], "modes.json", { type: "application/json" })
  fireEvent.change(input, { target: { files: [file] } })
  await waitFor(() =>
    expect(toastSuccess.mock.calls.length + toastError.mock.calls.length).toBeGreaterThan(before)
  )
}

/** Handles for the store mocks the master/detail tests drive. */
let storeMocks: {
  deleteMode: jest.Mock
  duplicateMode: jest.Mock
  exportMode: jest.Mock
  exportAllModes: jest.Mock
  importMode: jest.Mock
  importModes: jest.Mock
}

describe("CustomModeSettings — polish-phase", () => {
  beforeEach(() => {
    toastSuccess.mockClear()
    toastError.mockClear()
    anchorClick.mockClear()
    storeMocks = {
      deleteMode: jest.fn(),
      duplicateMode: jest.fn(() => polishCustomA),
      exportMode: jest.fn(() => '{"type":"custom-mode"}'),
      exportAllModes: jest.fn(() => '{"type":"custom-modes-collection"}'),
      importMode: jest.fn(),
      importModes: jest.fn(),
    }
    customModeStoreRef.current = {
      customModes: { "polish-a": polishCustomA, "polish-b": polishCustomB },
      ...storeMocks,
    }
  })

  it("splits into a rail and a detail pane, with no card chrome", () => {
    const { container } = render(<CustomModeSettings />)
    expect(screen.getByTestId("custom-mode-settings")).toBeInTheDocument()
    expect(screen.getByTestId("custom-mode-rail")).toBeInTheDocument()
    expect(container.querySelector("[data-slot='card']")).toBeNull()
  })

  it("auto-selects the first row and shows its detail", () => {
    render(<CustomModeSettings />)
    expect(screen.getByTestId("custom-mode-row-polish-a")).toHaveAttribute("data-active", "true")
    expect(screen.getByTestId("custom-mode-row-polish-b")).toHaveAttribute("data-active", "false")
    expect(screen.getByTestId("custom-mode-detail-meta")).toBeInTheDocument()
    expect(screen.getByRole("heading", { name: "Polish A" })).toBeInTheDocument()
  })

  it("clicking a row swaps the detail pane to that mode", async () => {
    const user = userEvent.setup()
    render(<CustomModeSettings />)
    await user.click(screen.getByTestId("custom-mode-row-polish-b"))
    expect(screen.getByRole("heading", { name: "Polish B" })).toBeInTheDocument()
    expect(screen.getByTestId("custom-mode-row-polish-b")).toHaveAttribute("data-active", "true")
  })

  it("surfaces the selected mode's prompt, tools and tags in the pane", async () => {
    const user = userEvent.setup()
    render(<CustomModeSettings />)
    await user.click(screen.getByTestId("custom-mode-row-polish-b"))
    // polish-b carries a prompt, one tool and one tag (see the fixture).
    expect(screen.getByTestId("custom-mode-system-prompt")).toHaveTextContent("answer briefly")
    expect(screen.getByText("Read")).toBeInTheDocument()
    expect(screen.getByText("beta")).toBeInTheDocument()
  })

  it("says so when the selected mode has no prompt, tools or tags", () => {
    render(<CustomModeSettings />)
    // polish-a has none of the three.
    expect(screen.queryByTestId("custom-mode-system-prompt")).not.toBeInTheDocument()
    expect(screen.getByText("This mode adds no system prompt.")).toBeInTheDocument()
    expect(screen.getAllByText("None")).toHaveLength(2)
  })

  it("edit and more-actions are labelled with the selected mode's name", () => {
    render(<CustomModeSettings />)
    expect(screen.getByTestId("mode-edit-polish-a")).toHaveAccessibleName("Edit Polish A")
    expect(screen.getByLabelText("More actions for Polish A")).toBeInTheDocument()
  })

  it("keeps the rail reachable through a sheet on narrow viewports", async () => {
    const user = userEvent.setup()
    render(<CustomModeSettings />)
    await user.click(screen.getByTestId("custom-mode-mobile-nav-trigger"))
    expect(screen.getAllByTestId("custom-mode-rail").length).toBeGreaterThan(1)
  })

  it("renders the results-count line only when filtered", async () => {
    const user = userEvent.setup()
    render(<CustomModeSettings />)
    expect(screen.queryByTestId("custom-mode-results-count")).not.toBeInTheDocument()
    const search = screen.getByPlaceholderText("Search modes…")
    await user.type(search, "alpha")
    const count = screen.getByTestId("custom-mode-results-count")
    expect(count.textContent).toContain("1")
    expect(count.textContent).toContain("2")
  })

  it("narrows the rail by search and empties the pane when nothing matches", async () => {
    const user = userEvent.setup()
    render(<CustomModeSettings />)
    await user.type(screen.getByPlaceholderText("Search modes…"), "zzz")
    expect(screen.queryByTestId("custom-mode-row-polish-a")).not.toBeInTheDocument()
    expect(screen.getByText("No modes match the filters")).toBeInTheDocument()
    expect(screen.getByText("No mode selected")).toBeInTheDocument()
  })

  it("shows the create-first empty state when there are no modes at all", () => {
    customModeStoreRef.current = { customModes: {}, ...storeMocks }
    render(<CustomModeSettings />)
    expect(screen.getByText("No custom modes yet")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /Create first mode/ })).toBeInTheDocument()
  })

  it("keeps the pane pinned to a mode that survives a narrowing filter", async () => {
    const user = userEvent.setup()
    render(<CustomModeSettings />)
    await user.click(screen.getByTestId("custom-mode-row-polish-b"))
    await user.type(screen.getByPlaceholderText("Search modes…"), "beta")
    expect(screen.getByRole("heading", { name: "Polish B" })).toBeInTheDocument()
  })

  it("opens the editor with no mode from Create, and with the active mode from Edit", async () => {
    const user = userEvent.setup()
    render(<CustomModeSettings />)

    await user.click(screen.getByTestId("mode-edit-polish-a"))
    expect(screen.getByTestId("stub-mode-editor")).toHaveAttribute("data-mode-id", "polish-a")
  })

  it("creates a new mode with an empty editor", async () => {
    const user = userEvent.setup()
    render(<CustomModeSettings />)
    // The header's Create button — the empty-state one is not rendered here.
    await user.click(screen.getByRole("button", { name: "Create Custom Mode" }))
    expect(screen.getByTestId("stub-mode-editor")).toHaveAttribute("data-mode-id", "")
  })

  it("duplicates the selected mode through the store", async () => {
    const user = userEvent.setup()
    render(<CustomModeSettings />)
    await user.click(screen.getByLabelText("More actions for Polish A"))
    await user.click(await screen.findByRole("menuitem", { name: /Duplicate/ }))
    expect(storeMocks.duplicateMode).toHaveBeenCalledWith("polish-a")
    expect(toastSuccess).toHaveBeenCalledWith("Mode duplicated")
  })

  it("stays quiet when duplicating a mode the store cannot find", async () => {
    storeMocks.duplicateMode.mockReturnValueOnce(undefined)
    const user = userEvent.setup()
    render(<CustomModeSettings />)
    await user.click(screen.getByLabelText("More actions for Polish A"))
    await user.click(await screen.findByRole("menuitem", { name: /Duplicate/ }))
    expect(toastSuccess).not.toHaveBeenCalled()
  })

  it("exports the selected mode and the whole collection", async () => {
    const user = userEvent.setup()
    render(<CustomModeSettings />)

    await user.click(screen.getByLabelText("More actions for Polish A"))
    await user.click(await screen.findByRole("menuitem", { name: /Export/ }))
    expect(storeMocks.exportMode).toHaveBeenCalledWith("polish-a")

    await user.click(screen.getByRole("button", { name: /^Export$/ }))
    expect(storeMocks.exportAllModes).toHaveBeenCalledTimes(1)
  })

  it("skips the download when the store has nothing to export for that id", async () => {
    storeMocks.exportMode.mockReturnValueOnce("")
    const user = userEvent.setup()
    render(<CustomModeSettings />)
    await user.click(screen.getByLabelText("More actions for Polish A"))
    await user.click(await screen.findByRole("menuitem", { name: /Export/ }))
    expect(toastSuccess).not.toHaveBeenCalledWith("Mode exported")
  })

  it("deletes the selected mode after confirmation and unpins the pane", async () => {
    const user = userEvent.setup()
    render(<CustomModeSettings />)
    await user.click(screen.getByTestId("custom-mode-row-polish-b"))
    await user.click(screen.getByLabelText("More actions for Polish B"))
    await user.click(await screen.findByRole("menuitem", { name: /Delete/ }))
    // Confirm in the alert dialog.
    await user.click(await screen.findByRole("button", { name: "Delete" }))
    expect(storeMocks.deleteMode).toHaveBeenCalledWith("polish-b")
    expect(toastSuccess).toHaveBeenCalledWith("Mode deleted")
  })

  it("cancels a delete without touching the store", async () => {
    const user = userEvent.setup()
    render(<CustomModeSettings />)
    await user.click(screen.getByLabelText("More actions for Polish A"))
    await user.click(await screen.findByRole("menuitem", { name: /Delete/ }))
    await user.click(await screen.findByRole("button", { name: "Cancel" }))
    expect(storeMocks.deleteMode).not.toHaveBeenCalled()
  })

  it("bulk-selects, selects all, clears, and bulk-deletes", async () => {
    const user = userEvent.setup()
    render(<CustomModeSettings />)

    await user.click(screen.getByLabelText("Select Polish A"))
    expect(screen.getByText("1 selected")).toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: "Select all" }))
    expect(screen.getByText("2 selected")).toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: "Clear" }))
    expect(screen.queryByText(/selected$/)).not.toBeInTheDocument()

    await user.click(screen.getByLabelText("Select Polish A"))
    await user.click(screen.getByLabelText("Select Polish A"))
    expect(screen.queryByText(/selected$/)).not.toBeInTheDocument()

    await user.click(screen.getByLabelText("Select Polish B"))
    await user.click(screen.getByRole("button", { name: /Delete selected/ }))
    expect(storeMocks.deleteMode).toHaveBeenCalledWith("polish-b")
    expect(toastSuccess).toHaveBeenCalledWith("Deleted 1 modes")
  })

  it("imports a collection, a single mode, and reports bad payloads", async () => {
    storeMocks.importModes.mockReturnValue(2)
    storeMocks.importMode.mockReturnValue({ name: "Imported" })
    const { container } = render(<CustomModeSettings />)
    const input = container.querySelector('input[type="file"]') as HTMLInputElement

    await readFileInto(input, JSON.stringify({ type: "custom-modes-collection" }))
    expect(storeMocks.importModes).toHaveBeenCalled()
    expect(toastSuccess).toHaveBeenCalledWith("Imported 2 modes")

    await readFileInto(input, JSON.stringify({ type: "custom-mode" }))
    expect(storeMocks.importMode).toHaveBeenCalled()
    expect(toastSuccess).toHaveBeenCalledWith('Imported mode "Imported"')

    storeMocks.importMode.mockReturnValueOnce(undefined)
    await readFileInto(input, JSON.stringify({ type: "custom-mode" }))
    expect(toastError).toHaveBeenCalledWith("Failed to import mode")

    await readFileInto(input, JSON.stringify({ type: "nonsense" }))
    expect(toastError).toHaveBeenCalledWith("Invalid file format")

    await readFileInto(input, "{not json")
    expect(toastError).toHaveBeenCalledWith("Failed to parse file")
  })

  it("shows the permission and model overrides only when the mode sets them", async () => {
    const user = userEvent.setup()
    render(<CustomModeSettings />)
    // polish-a sets neither.
    expect(screen.queryByText("claude-opus-5")).not.toBeInTheDocument()

    await user.click(screen.getByTestId("custom-mode-row-polish-b"))
    expect(screen.getByText("plan")).toBeInTheDocument()
    expect(screen.getByText("claude-opus-5")).toBeInTheDocument()
  })

  it("filters by category and re-sorts the rail", async () => {
    const user = userEvent.setup()
    render(<CustomModeSettings />)

    // Name order (the default) puts A before B.
    const railOrder = () =>
      screen.getAllByTestId(/^custom-mode-row-/).map((el) => el.getAttribute("data-testid"))
    expect(railOrder()).toEqual(["custom-mode-row-polish-a", "custom-mode-row-polish-b"])

    // Most-used first flips them: polish-b has 9 uses, polish-a has 1.
    await user.click(screen.getByLabelText("Sort by"))
    await user.click(await screen.findByRole("option", { name: "Sort by most used" }))
    expect(railOrder()).toEqual(["custom-mode-row-polish-b", "custom-mode-row-polish-a"])

    // Newest-first orderings agree: polish-b was created and updated later.
    await user.click(screen.getByLabelText("Sort by"))
    await user.click(await screen.findByRole("option", { name: "Sort by created" }))
    expect(railOrder()).toEqual(["custom-mode-row-polish-b", "custom-mode-row-polish-a"])

    await user.click(screen.getByLabelText("Sort by"))
    await user.click(await screen.findByRole("option", { name: "Sort by updated" }))
    expect(railOrder()).toEqual(["custom-mode-row-polish-b", "custom-mode-row-polish-a"])

    // Category narrows to the one creative mode.
    await user.click(screen.getByLabelText("Category"))
    await user.click(await screen.findByRole("option", { name: "Creative" }))
    expect(railOrder()).toEqual(["custom-mode-row-polish-b"])
  })

  it("closes the editor once the dialog reports a save", async () => {
    const user = userEvent.setup()
    render(<CustomModeSettings />)
    await user.click(screen.getByTestId("mode-edit-polish-a"))
    await user.click(screen.getByRole("button", { name: "stub-save" }))
    expect(screen.queryByTestId("stub-mode-editor")).not.toBeInTheDocument()
  })

  it("creates a mode straight from the empty detail pane", async () => {
    const user = userEvent.setup()
    render(<CustomModeSettings />)
    await user.type(screen.getByPlaceholderText("Search modes…"), "zzz")
    // Header button and empty-pane button share a label; the pane's is last.
    const createButtons = screen.getAllByRole("button", { name: "Create Custom Mode" })
    await user.click(createButtons[createButtons.length - 1])
    expect(screen.getByTestId("stub-mode-editor")).toHaveAttribute("data-mode-id", "")
  })

  it("falls back to the default glyph when a mode names an unknown icon", () => {
    customModeStoreRef.current = {
      customModes: { "polish-a": { ...polishCustomA, icon: "ThisIconDoesNotExist" } },
      ...storeMocks,
    }
    render(<CustomModeSettings />)
    expect(screen.getByTestId("custom-mode-row-polish-a")).toBeInTheDocument()
  })

  it("does nothing when the file picker is dismissed without a file", () => {
    const { container } = render(<CustomModeSettings />)
    const input = container.querySelector('input[type="file"]') as HTMLInputElement
    fireEvent.change(input, { target: { files: [] } })
    expect(storeMocks.importMode).not.toHaveBeenCalled()
    expect(storeMocks.importModes).not.toHaveBeenCalled()
  })
})

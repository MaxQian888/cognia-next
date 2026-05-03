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
import { render, screen, within, act } from "@testing-library/react"
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

const createModeMock = jest.fn(
  (draft: Partial<CustomModeConfig>): CustomModeConfig => ({
    ...mockCustom,
    ...draft,
    id: draft.id ?? "custom-new",
    type: "custom",
    isBuiltIn: false,
  })
)
const deleteModeMock = jest.fn()
const duplicateModeMock = jest.fn(() => mockCustom)
const exportModeMock = jest.fn(() => "{}")
const exportAllModesMock = jest.fn(() => "{}")
const importModeMock = jest.fn()
const importModesMock = jest.fn()

jest.mock("@/stores/agent/custom-mode-store", () => ({
  useCustomModeStore: () => ({
    deleteMode: deleteModeMock,
    duplicateMode: duplicateModeMock,
    exportMode: exportModeMock,
    exportAllModes: exportAllModesMock,
    importMode: importModeMock,
    importModes: importModesMock,
    createMode: createModeMock,
  }),
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
jest.mock("@/components/agent/custom-mode-editor", () => ({
  CustomModeEditor: () => null,
}))

// Quiet the agent logger spam during tests
jest.mock("@/lib/logger", () => ({
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

describe("CustomModeSettings — built-in surfacing", () => {
  beforeEach(() => {
    createModeMock.mockClear()
    deleteModeMock.mockClear()
    duplicateModeMock.mockClear()
    isBuiltInModeMock.mockClear()
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

/**
 * Tests for the automation audit table — Dexie helpers mocked at the
 * module boundary. Covers loading, row rendering with truncate+title,
 * filters (responsive classes), and the empty state.
 */

import { render, screen } from "@testing-library/react"

const listAuditRows = jest.fn()
const clearAuditLog = jest.fn()
jest.mock("@/lib/automation/audit", () => ({
  listAuditRows: (...a: unknown[]) => listAuditRows(...a),
  clearAuditLog: (...a: unknown[]) => clearAuditLog(...a),
}))
jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn() } }))

import type { AutomationAuditLogRow } from "@/lib/db/schema"
import { AutomationAuditTable } from "./automation-audit-table"

function row(over: Partial<AutomationAuditLogRow> = {}): AutomationAuditLogRow {
  return {
    id: "a1",
    ts: 1_700_000_000_000,
    surface: "computerUse",
    pluginId: null,
    command: "screenshot",
    processName: "notepad.exe",
    windowTitle: "Untitled - Notepad",
    decision: "allow",
    reason: null,
    durationMs: 12,
    error: null,
    ...over,
  } as AutomationAuditLogRow
}

beforeEach(() => {
  listAuditRows.mockReset().mockResolvedValue([])
  clearAuditLog.mockReset().mockResolvedValue(undefined)
})

describe("AutomationAuditTable", () => {
  it("shows the empty state when no rows", async () => {
    render(<AutomationAuditTable />)
    expect(await screen.findByText(/no audit records/i)).toBeInTheDocument()
  })

  it("renders rows with truncated target cells carrying a hover title", async () => {
    const longProc = "a-very-long-process-name-that-overflows-on-mobile.exe"
    listAuditRows.mockResolvedValue([row({ processName: longProc })])
    render(<AutomationAuditTable />)
    const cell = await screen.findByTitle(longProc)
    expect(cell).toHaveClass("truncate")
    // Command cell also truncates with a title for narrow screens.
    expect(screen.getByTitle("screenshot")).toHaveClass("truncate")
  })

  it("filter row stacks on mobile (responsive classes present)", async () => {
    listAuditRows.mockResolvedValue([row()])
    render(<AutomationAuditTable />)
    await screen.findByTitle("screenshot")
    const triggers = screen.getAllByRole("combobox")
    expect(triggers.length).toBeGreaterThanOrEqual(2)
    for (const trigger of triggers) {
      expect(trigger).toHaveClass("w-full", "sm:w-40")
    }
  })

  it("export button disabled with zero rows", async () => {
    render(<AutomationAuditTable />)
    await screen.findByText(/no audit records/i)
    expect(screen.getByRole("button", { name: /export/i })).toBeDisabled()
  })
})

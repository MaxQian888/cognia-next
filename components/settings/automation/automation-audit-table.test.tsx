/**
 * Tests for the automation audit table — Dexie helpers mocked at the
 * module boundary. Covers loading, row rendering with truncate+title,
 * filters (responsive classes), and the empty state.
 */

import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { toast } from "sonner"

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

  /**
   * Six columns do not fit a phone. The table stays for wide viewports and the
   * same rows render as cards below `sm`, so a reader never has to scroll
   * sideways to find out what was denied.
   */
  it("renders the same rows as cards for a narrow viewport", async () => {
    listAuditRows.mockResolvedValue([row()])
    render(<AutomationAuditTable />)
    await screen.findByTitle("screenshot")

    const cards = screen.getByTestId("audit-cards")
    expect(cards.className).toContain("sm:hidden")
    expect(cards.querySelectorAll("li").length).toBeGreaterThan(0)

    const tableWrap = screen.getByTestId("audit-table-wrap")
    expect(tableWrap.className).toContain("hidden")
    expect(tableWrap.className).toContain("sm:block")
    expect(tableWrap.querySelector("table")).not.toBeNull()
  })
  describe("clearing the log", () => {
    it("asks in a themed dialog and keeps the log when cancelled", async () => {
      const user = userEvent.setup()
      listAuditRows.mockResolvedValue([row()])
      render(<AutomationAuditTable />)
      await screen.findByTitle("screenshot")
      await user.click(screen.getByRole("button", { name: /clear log/i }))
      const dialog = await screen.findByRole("alertdialog", { name: "Clear the audit log?" })
      expect(dialog).toHaveAccessibleDescription(/cannot be undone/i)
      await user.click(within(dialog).getByRole("button", { name: "Cancel" }))
      await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument())
      expect(clearAuditLog).not.toHaveBeenCalled()
    })

    it("clears, reloads and confirms with a toast once accepted", async () => {
      const user = userEvent.setup()
      listAuditRows.mockResolvedValue([row()])
      render(<AutomationAuditTable />)
      await screen.findByTitle("screenshot")
      await user.click(screen.getByRole("button", { name: /clear log/i }))
      const dialog = await screen.findByRole("alertdialog")
      listAuditRows.mockResolvedValue([])
      await user.click(within(dialog).getByRole("button", { name: "Clear log" }))
      await waitFor(() => expect(clearAuditLog).toHaveBeenCalledTimes(1))
      await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Audit log cleared"))
      expect(await screen.findByText(/no audit records/i)).toBeInTheDocument()
    })

    it("reports a failed clear instead of claiming success", async () => {
      const user = userEvent.setup()
      listAuditRows.mockResolvedValue([row()])
      clearAuditLog.mockRejectedValue(new Error("disk"))
      ;(toast.success as jest.Mock).mockClear()
      render(<AutomationAuditTable />)
      await screen.findByTitle("screenshot")
      await user.click(screen.getByRole("button", { name: /clear log/i }))
      await user.click(
        within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Clear log" })
      )
      await waitFor(() =>
        expect(toast.error).toHaveBeenCalledWith("Failed to clear the audit log", {
          description: "Error: disk",
        })
      )
      expect(toast.success).not.toHaveBeenCalled()
    })
  })
})

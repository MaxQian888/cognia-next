/**
 * @jest-environment jsdom
 */

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))

const mockIsTauri = jest.fn(() => true)
jest.mock("@/lib/tauri", () => ({ isTauri: () => mockIsTauri() }))

jest.mock("@/lib/logging", () => ({ loggers: { mcp: { error: jest.fn() } } }))
jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn() } }))

const getMcpServerStatus = jest.fn()
jest.mock("@/lib/external-bridge/tauri-control", () => ({
  getMcpServerStatus: () => getMcpServerStatus(),
}))

const listMcpAuditLog = jest.fn()
const clearMcpAuditLog = jest.fn().mockResolvedValue(undefined)
jest.mock("@/lib/db/mcp-audit-log", () => ({
  listMcpAuditLog: (...a: unknown[]) => listMcpAuditLog(...a),
  clearMcpAuditLog: () => clearMcpAuditLog(),
}))

import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { McpHealthTab } from "./mcp-health-tab"
import type { McpAuditLogRow } from "@/types/wiki"

const rows: McpAuditLogRow[] = [
  {
    id: "1",
    ts: 1_700_000_000_000,
    tool: "wiki_search",
    scope: "wiki:cognia",
    allowed: true,
    latencyMs: 12,
  },
  {
    id: "2",
    ts: 1_700_000_001_000,
    tool: "rag_search",
    scope: "rag:cognia",
    allowed: false,
    latencyMs: 4,
    reason: "scope OFF",
  },
]

beforeEach(() => {
  mockIsTauri.mockReturnValue(true)
  getMcpServerStatus.mockResolvedValue({ running: true, port: 8765, startedAt: null })
  listMcpAuditLog.mockResolvedValue(rows)
  clearMcpAuditLog.mockClear()
})

describe("McpHealthTab", () => {
  it("renders the bridge running status and the audit rows", async () => {
    render(<McpHealthTab />)
    await waitFor(() => expect(screen.getByText("running")).toBeInTheDocument())
    expect(screen.getByText('port:{"port":8765}')).toBeInTheDocument()
    await waitFor(() => expect(screen.getByText("wiki_search")).toBeInTheDocument())
    expect(screen.getByText("rag_search")).toBeInTheDocument()
  })

  it("wraps the audit table in a horizontal-scroll container for narrow screens", async () => {
    render(<McpHealthTab />)
    await waitFor(() => expect(screen.getByText("wiki_search")).toBeInTheDocument())
    const scroll = screen.getByTestId("mcp-health-audit-scroll")
    expect(scroll).toHaveClass("overflow-x-auto")
    expect(scroll.querySelector("table")).toBeInTheDocument()
  })

  it("re-queries the log when the denied-only filter is toggled", async () => {
    render(<McpHealthTab />)
    await waitFor(() =>
      expect(listMcpAuditLog).toHaveBeenCalledWith({ deniedOnly: false, limit: 100 })
    )
    fireEvent.click(screen.getByLabelText("deniedOnly"))
    await waitFor(() =>
      expect(listMcpAuditLog).toHaveBeenCalledWith({ deniedOnly: true, limit: 100 })
    )
  })

  it("clears the log", async () => {
    render(<McpHealthTab />)
    await waitFor(() => expect(screen.getByText("wiki_search")).toBeInTheDocument())
    fireEvent.click(screen.getByText("clearLog"))
    await waitFor(() => expect(clearMcpAuditLog).toHaveBeenCalled())
  })

  it("shows a desktop-only notice off Tauri", async () => {
    mockIsTauri.mockReturnValue(false)
    getMcpServerStatus.mockResolvedValue({ running: false, port: null, startedAt: null })
    listMcpAuditLog.mockResolvedValue([])
    render(<McpHealthTab />)
    await waitFor(() => expect(screen.getByText("desktopOnly")).toBeInTheDocument())
  })
})

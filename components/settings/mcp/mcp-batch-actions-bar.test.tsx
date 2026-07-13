/**
 * @jest-environment jsdom
 */

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))

jest.mock("sonner", () => ({
  toast: { success: jest.fn(), error: jest.fn(), warning: jest.fn() },
}))

jest.mock("@cognia/logging", () => ({
  loggers: { mcp: { info: jest.fn(), error: jest.fn(), warn: jest.fn() } },
}))

const updateMcpServer = jest.fn().mockResolvedValue(undefined)
const deleteMcpServer = jest.fn().mockResolvedValue(undefined)
jest.mock("@/lib/db/mcp-servers", () => ({
  updateMcpServer: (...a: unknown[]) => updateMcpServer(...a),
  deleteMcpServer: (...a: unknown[]) => deleteMcpServer(...a),
}))

const scheduleSync = jest.fn()
jest.mock("@/lib/claude/sync", () => ({ scheduleSync: (...a: unknown[]) => scheduleSync(...a) }))

import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { toast } from "sonner"
import { McpBatchActionsBar } from "./mcp-batch-actions-bar"
import { useMcpPanelStore } from "@/stores/mcp/mcp-panel-store"
import type { McpServer } from "@cognia/agent-config-types"

const servers: McpServer[] = [
  {
    id: "a",
    name: "alpha",
    transport: "stdio",
    config: { command: "x" },
    enabled: true,
    appsEnabled: { "claude-code": true },
    createdAt: 0,
    updatedAt: 0,
  } as McpServer,
  {
    id: "b",
    name: "bravo",
    transport: "http",
    config: { url: "https://x" },
    enabled: true,
    appsEnabled: {},
    createdAt: 0,
    updatedAt: 0,
  } as McpServer,
]

beforeEach(() => {
  updateMcpServer.mockClear()
  deleteMcpServer.mockClear()
  scheduleSync.mockClear()
  ;(toast.success as jest.Mock).mockClear()
  useMcpPanelStore.setState({ selection: new Set(["a", "b"]) })
})

describe("McpBatchActionsBar", () => {
  it("is hidden when the selection is empty", () => {
    useMcpPanelStore.setState({ selection: new Set() })
    render(<McpBatchActionsBar servers={servers} />)
    expect(screen.queryByTestId("mcp-batch-actions-bar")).not.toBeInTheDocument()
  })

  it("shows the selected count", () => {
    render(<McpBatchActionsBar servers={servers} />)
    expect(screen.getByText('selectedCount:{"count":2}')).toBeInTheDocument()
  })

  it("batch-enables the selected servers and clears the selection", async () => {
    render(<McpBatchActionsBar servers={servers} />)
    fireEvent.click(screen.getByText("enable"))
    await waitFor(() => expect(updateMcpServer).toHaveBeenCalledTimes(2))
    expect(updateMcpServer).toHaveBeenCalledWith("a", { enabled: true })
    expect(useMcpPanelStore.getState().selection.size).toBe(0)
  })

  it("batch-deletes the selected servers", async () => {
    render(<McpBatchActionsBar servers={servers} />)
    fireEvent.click(screen.getByText("delete"))
    await waitFor(() => expect(deleteMcpServer).toHaveBeenCalledTimes(2))
  })

  it("re-syncs the union of projected agents", async () => {
    render(<McpBatchActionsBar servers={servers} />)
    fireEvent.click(screen.getByText("sync"))
    await waitFor(() => expect(scheduleSync).toHaveBeenCalledWith("claude-code"))
  })
})

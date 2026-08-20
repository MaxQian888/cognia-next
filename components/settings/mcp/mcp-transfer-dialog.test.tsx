/**
 * @jest-environment jsdom
 */

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))

jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn() } }))
jest.mock("@cognia/logging", () => ({
  loggers: { mcp: { info: jest.fn(), error: jest.fn() } },
}))

jest.mock("@/lib/db/mcp-servers", () => ({
  bulkImportMcpServers: jest
    .fn()
    .mockResolvedValue({ created: 1, updated: 0, skipped: 0, errored: [] }),
}))

import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { McpTransferDialog } from "./mcp-transfer-dialog"
import { bulkImportMcpServers } from "@/lib/db/mcp-servers"
import { useMcpPanelStore } from "@/stores/mcp/mcp-panel-store"

const paste = (value: string) =>
  fireEvent.change(screen.getByTestId("mcp-transfer-input"), { target: { value } })

beforeEach(() => {
  ;(bulkImportMcpServers as jest.Mock).mockClear()
  useMcpPanelStore.setState({ transferOpen: true })
})

describe("McpTransferDialog", () => {
  it("previews a claude install command", () => {
    render(<McpTransferDialog />)
    paste("claude mcp add filesystem -- npx -y @modelcontextprotocol/server-filesystem /tmp")
    expect(screen.getByTestId("mcp-transfer-preview")).toHaveTextContent("filesystem")
    expect(screen.getByText('importN:{"count":1}')).toBeInTheDocument()
  })

  it("previews an mcpServers JSON block", () => {
    render(<McpTransferDialog />)
    paste(JSON.stringify({ mcpServers: { a: { command: "x" }, b: { url: "https://b.dev/mcp" } } }))
    const preview = screen.getByTestId("mcp-transfer-preview")
    expect(preview).toHaveTextContent("a")
    expect(preview).toHaveTextContent("b")
  })

  it("explains why a paste could not be read", () => {
    render(<McpTransferDialog />)
    paste("{not json")
    expect(screen.getByTestId("mcp-transfer-error")).toHaveTextContent("errors.invalid-json")
  })

  it("surfaces a guessed name as a warning", () => {
    render(<McpTransferDialog />)
    paste("npx -y @modelcontextprotocol/server-memory")
    expect(screen.getByTestId("mcp-transfer-warnings")).toHaveTextContent("guessedName")
  })

  it("imports only the checked entries", async () => {
    render(<McpTransferDialog />)
    paste(JSON.stringify({ mcpServers: { a: { command: "x" }, b: { command: "y" } } }))
    fireEvent.click(screen.getAllByRole("checkbox")[0])
    expect(screen.getByText('importN:{"count":1}')).toBeInTheDocument()
    fireEvent.click(screen.getByText('importN:{"count":1}'))
    await waitFor(() => expect(bulkImportMcpServers).toHaveBeenCalled())
    const [drafts] = (bulkImportMcpServers as jest.Mock).mock.calls[0]
    expect(drafts).toEqual([{ name: "b", transport: "stdio", config: { command: "y" } }])
  })

  it("passes the chosen collision strategy through", async () => {
    render(<McpTransferDialog />)
    paste("claude mcp add x -- node s.js")
    fireEvent.click(screen.getByText("strategy.overwrite"))
    fireEvent.click(screen.getByText('importN:{"count":1}'))
    await waitFor(() => expect(bulkImportMcpServers).toHaveBeenCalled())
    expect((bulkImportMcpServers as jest.Mock).mock.calls[0][1]).toBe("overwrite")
  })

  it("closes and clears after a successful import", async () => {
    const onImported = jest.fn()
    render(<McpTransferDialog onImported={onImported} />)
    paste("claude mcp add x -- node s.js")
    fireEvent.click(screen.getByText('importN:{"count":1}'))
    await waitFor(() => expect(useMcpPanelStore.getState().transferOpen).toBe(false))
    expect(onImported).toHaveBeenCalled()
  })

  it("keeps the import button inert until something parses", () => {
    render(<McpTransferDialog />)
    expect(screen.getByText('importN:{"count":0}')).toBeDisabled()
  })
})

/**
 * @jest-environment jsdom
 */

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))

jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn() } }))

let mockServers: unknown[] = []
jest.mock("dexie-react-hooks", () => ({ useLiveQuery: () => mockServers }))
jest.mock("@/lib/db/mcp-servers", () => ({ listMcpServers: jest.fn() }))

const writeClipboardText = jest.fn().mockResolvedValue(undefined)
jest.mock("@/lib/tauri/clipboard", () => ({
  writeClipboardText: (text: string) => writeClipboardText(text),
}))

const downloadFile = jest.fn()
jest.mock("@/lib/files/download", () => ({
  downloadFile: (...args: unknown[]) => downloadFile(...args),
}))

import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { McpExportDialog } from "./mcp-export-dialog"
import { useMcpPanelStore } from "@/stores/mcp/mcp-panel-store"
import type { McpServer } from "@cognia/agent-config-types"

const server = (id: string, patch: Partial<McpServer> = {}): McpServer =>
  ({
    id,
    name: id,
    transport: "stdio",
    config: { command: "npx", args: ["-y", `${id}-mcp`] },
    enabled: true,
    appsEnabled: {},
    createdAt: 0,
    updatedAt: 0,
    ...patch,
  }) as McpServer

const output = () => (screen.getByTestId("mcp-export-output") as HTMLTextAreaElement).value

beforeEach(() => {
  writeClipboardText.mockClear()
  downloadFile.mockClear()
  mockServers = [server("alpha"), server("bravo")]
  useMcpPanelStore.setState({ exportTarget: { serverIds: ["alpha"] } })
})

describe("McpExportDialog", () => {
  it("renders only the targeted server", () => {
    render(<McpExportDialog />)
    expect(output()).toContain("alpha")
    expect(output()).not.toContain("bravo")
  })

  it("treats an empty id list as 'every server'", () => {
    useMcpPanelStore.setState({ exportTarget: { serverIds: [] } })
    render(<McpExportDialog />)
    expect(output()).toContain("alpha")
    expect(output()).toContain("bravo")
  })

  it("emits the portable mcpServers block by default", () => {
    render(<McpExportDialog />)
    expect(JSON.parse(output())).toHaveProperty("mcpServers.alpha.command", "npx")
  })

  it("switches to an install command", () => {
    render(<McpExportDialog />)
    fireEvent.click(screen.getByText("formatCommand"))
    expect(output()).toBe("npx -y alpha-mcp")
  })

  it("copies the rendered output", async () => {
    render(<McpExportDialog />)
    fireEvent.click(screen.getByText("copy"))
    await waitFor(() => expect(writeClipboardText).toHaveBeenCalledWith(output()))
  })

  it("downloads JSON as .json and a command list as .sh", () => {
    render(<McpExportDialog />)
    fireEvent.click(screen.getByText("download"))
    expect(downloadFile.mock.calls[0][0]).toBe("cognia-mcp-servers.json")
    fireEvent.click(screen.getByText("formatCommand"))
    fireEvent.click(screen.getByText("download"))
    expect(downloadFile.mock.calls[1][0]).toBe("cognia-mcp-servers.sh")
  })

  it("exports a credential as its reference, never as the secret", () => {
    mockServers = [
      server("alpha", {
        config: { command: "node", env: { TOKEN: { secretRef: "mcp/alpha/TOKEN" } } } as never,
      }),
    ]
    render(<McpExportDialog />)
    fireEvent.click(screen.getByText("formatCommand"))
    expect(output()).toContain("mcp/alpha/TOKEN")
  })

  it("stays closed with no export target", () => {
    useMcpPanelStore.setState({ exportTarget: null })
    render(<McpExportDialog />)
    expect(screen.queryByTestId("mcp-export-output")).not.toBeInTheDocument()
  })
})

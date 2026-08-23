/** @jest-environment jsdom */
import { fireEvent, render, screen, waitFor } from "@testing-library/react"

const loadMock = jest.fn()
const callMock = jest.fn()
const promoteMock = jest.fn()
jest.mock("@/lib/mcp/apps-runtime", () => ({
  loadMcpAppForTool: (...args: unknown[]) => loadMock(...args),
  callMcpAppTool: (...args: unknown[]) => callMock(...args),
  promoteMcpAppDownload: (...args: unknown[]) => promoteMock(...args),
  getMcpAppToolRisk: () => "write",
}))
jest.mock("@/lib/tauri/opener", () => ({ openExternal: jest.fn() }))
jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${JSON.stringify(values)}` : key,
}))
jest.mock("./mcp-app-frame", () => ({
  McpAppFrame: (props: { quarantineDownload: (contents: unknown[]) => void }) => (
    <button onClick={() => props.quarantineDownload([{ type: "resource" }])}>app-frame</button>
  ),
}))

import { ManagedMcpAppCard } from "./managed-mcp-app-card"

const app = {
  server: { id: "server", name: "figma", toolRiskRules: [] },
  toolName: "edit",
  resourceUri: "ui://figma/editor",
  html: "<main>Editor</main>",
  csp: { connectDomains: ["https://api.figma.com"] },
  permissions: { clipboardWrite: {} },
  risk: "write",
}

const part = {
  type: "tool-mcp__figma__edit",
  toolCallId: "call",
  state: "output-available",
  input: { node: "1" },
  output: "ok",
} as never

beforeEach(() => {
  loadMock.mockReset()
  callMock.mockReset()
  promoteMock.mockReset()
})

describe("ManagedMcpAppCard", () => {
  it("stays absent for ordinary MCP tools", async () => {
    loadMock.mockResolvedValue(undefined)
    const { container } = render(
      <ManagedMcpAppCard part={part} namespacedToolName="mcp__figma__edit" sessionId="chat" />
    )
    await waitFor(() => expect(loadMock).toHaveBeenCalled())
    expect(container).toBeEmptyDOMElement()
  })

  it("requires every origin and device permission before mounting the sandbox", async () => {
    loadMock.mockResolvedValue(app)
    render(<ManagedMcpAppCard part={part} namespacedToolName="mcp__figma__edit" sessionId="chat" />)
    expect(await screen.findByText("reviewTitle")).toBeInTheDocument()
    expect(screen.queryByText("app-frame")).toBeNull()
    fireEvent.click(screen.getByLabelText("connectDomains: https://api.figma.com"))
    expect(screen.queryByText("app-frame")).toBeNull()
    fireEvent.click(screen.getByLabelText("clipboardWrite"))
    expect(await screen.findByText("app-frame")).toBeInTheDocument()
  })

  it("keeps downloads quarantined until the user saves or discards them", async () => {
    loadMock.mockResolvedValue({ ...app, csp: undefined, permissions: undefined })
    promoteMock.mockResolvedValue(1)
    render(<ManagedMcpAppCard part={part} namespacedToolName="mcp__figma__edit" sessionId="chat" />)
    fireEvent.click(await screen.findByText("app-frame"))
    expect(screen.getByText(/quarantinedDownload/)).toBeInTheDocument()
    fireEvent.click(screen.getByText("saveDownload"))
    await waitFor(() => expect(promoteMock).toHaveBeenCalled())
    await waitFor(() => expect(screen.queryByText(/quarantinedDownload/)).toBeNull())
  })
})

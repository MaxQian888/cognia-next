/** @jest-environment jsdom */
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

const loadMock = jest.fn()
const callMock = jest.fn()
const promoteMock = jest.fn()
const toolRisk: { value: "read" | "write" | "destructive" } = { value: "write" }
jest.mock("@/lib/mcp/apps-runtime", () => ({
  loadMcpAppForTool: (...args: unknown[]) => loadMock(...args),
  callMcpAppTool: (...args: unknown[]) => callMock(...args),
  promoteMcpAppDownload: (...args: unknown[]) => promoteMock(...args),
  getMcpAppToolRisk: () => toolRisk.value,
}))
jest.mock("@/lib/tauri/opener", () => ({ openExternal: jest.fn() }))
jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${JSON.stringify(values)}` : key,
}))
// Answers the frame's approval callbacks resolved with, in call order.
const answers: Array<boolean> = []
jest.mock("./mcp-app-frame", () => ({
  McpAppFrame: (props: {
    quarantineDownload: (contents: unknown[]) => void
    authorizeToolCall: (request: { name: string }) => boolean | Promise<boolean>
    confirmOpenLink: (request: { url: string; hostname: string }) => boolean | Promise<boolean>
    confirmDownload: (request: { contents: unknown[] }) => boolean | Promise<boolean>
  }) => (
    <>
      <button onClick={() => props.quarantineDownload([{ type: "resource" }])}>app-frame</button>
      <button
        onClick={() =>
          void Promise.resolve(props.authorizeToolCall({ name: "delete_node" })).then((value) =>
            answers.push(value)
          )
        }
      >
        call-tool
      </button>
      <button
        onClick={() =>
          void Promise.resolve(
            props.confirmOpenLink({ url: "https://figma.com/x", hostname: "figma.com" })
          ).then((value) => answers.push(value))
        }
      >
        open-link
      </button>
      <button
        onClick={() =>
          void Promise.resolve(props.confirmDownload({ contents: [] })).then((value) =>
            answers.push(value)
          )
        }
      >
        download
      </button>
    </>
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
  answers.length = 0
  toolRisk.value = "write"
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

  describe("approvals", () => {
    const loaded = { ...app, csp: undefined, permissions: undefined }

    it("asks once for an ordinary tool call and passes the answer back", async () => {
      loadMock.mockResolvedValue(loaded)
      const user = userEvent.setup()
      render(
        <ManagedMcpAppCard part={part} namespacedToolName="mcp__figma__edit" sessionId="chat" />
      )
      await user.click(await screen.findByText("call-tool"))
      const dialog = await screen.findByTestId("mcp-app-approve-tool")
      expect(dialog).toHaveTextContent('toolCall.title:{"tool":"delete_node"}')
      expect(dialog).toHaveTextContent('"server":"figma"')
      expect(dialog).toHaveTextContent('"risk":"risk.write"')
      await user.click(within(dialog).getByTestId("mcp-app-approve-tool-confirm"))
      await waitFor(() => expect(answers).toEqual([true]))
      expect(screen.queryByTestId("mcp-app-approve-destructive")).toBeNull()
    })

    it("needs a second, separate yes for a destructive tool and denies when it is refused", async () => {
      toolRisk.value = "destructive"
      loadMock.mockResolvedValue(loaded)
      const user = userEvent.setup()
      render(
        <ManagedMcpAppCard part={part} namespacedToolName="mcp__figma__edit" sessionId="chat" />
      )
      await user.click(await screen.findByText("call-tool"))
      await user.click(
        within(await screen.findByTestId("mcp-app-approve-tool")).getByTestId(
          "mcp-app-approve-tool-confirm"
        )
      )
      const second = await screen.findByTestId("mcp-app-approve-destructive")
      expect(answers).toEqual([])
      await user.click(within(second).getByTestId("mcp-app-approve-destructive-cancel"))
      await waitFor(() => expect(answers).toEqual([false]))
    })

    it("allows a destructive tool only after both approvals", async () => {
      toolRisk.value = "destructive"
      loadMock.mockResolvedValue(loaded)
      const user = userEvent.setup()
      render(
        <ManagedMcpAppCard part={part} namespacedToolName="mcp__figma__edit" sessionId="chat" />
      )
      await user.click(await screen.findByText("call-tool"))
      await user.click(await screen.findByTestId("mcp-app-approve-tool-confirm"))
      await user.click(await screen.findByTestId("mcp-app-approve-destructive-confirm"))
      await waitFor(() => expect(answers).toEqual([true]))
    })

    it("answers queued link and download requests separately, in order", async () => {
      loadMock.mockResolvedValue(loaded)
      const user = userEvent.setup()
      render(
        <ManagedMcpAppCard part={part} namespacedToolName="mcp__figma__edit" sessionId="chat" />
      )
      fireEvent.click(await screen.findByText("open-link"))
      fireEvent.click(screen.getByText("download"))
      const link = await screen.findByTestId("mcp-app-approve-link")
      expect(link).toHaveTextContent('"hostname":"figma.com"')
      await user.click(within(link).getByTestId("mcp-app-approve-link-cancel"))
      await user.click(await screen.findByTestId("mcp-app-approve-download-confirm"))
      await waitFor(() => expect(answers).toEqual([false, true]))
    })

    it("denies a pending request when the card unmounts", async () => {
      loadMock.mockResolvedValue(loaded)
      const { unmount } = render(
        <ManagedMcpAppCard part={part} namespacedToolName="mcp__figma__edit" sessionId="chat" />
      )
      fireEvent.click(await screen.findByText("call-tool"))
      await screen.findByTestId("mcp-app-approve-tool")
      unmount()
      await waitFor(() => expect(answers).toEqual([false]))
    })
  })
})

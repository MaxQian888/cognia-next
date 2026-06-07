import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { LspLogsDialog } from "./lsp-logs-dialog"
import { useLspStatusStore, __resetLspStatusStoreForTesting } from "@/lib/lsp/lsp-status-store"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

const loadLogsMock = jest.fn(async () => {})

beforeEach(() => {
  __resetLspStatusStoreForTesting()
  loadLogsMock.mockClear()
  useLspStatusStore.setState({ loadLogs: loadLogsMock })
})

describe("LspLogsDialog", () => {
  it("loads logs on open and shows the empty state", async () => {
    render(<LspLogsDialog open onOpenChange={() => {}} />)
    expect(await screen.findByTestId("lsp-logs-dialog")).toBeInTheDocument()
    expect(loadLogsMock).toHaveBeenCalledTimes(1)
    expect(screen.getByText("empty")).toBeInTheDocument()
  })

  it("renders log entries with server id and message", async () => {
    useLspStatusStore.setState({
      logs: [
        { ts: 1700000000000, level: "error", key: "agent:ts", serverId: "ts", message: "boom" },
        { ts: 1700000001000, level: "info", key: "agent:py", serverId: "py", message: "started" },
      ],
    })
    render(<LspLogsDialog open onOpenChange={() => {}} />)
    const list = await screen.findByTestId("lsp-logs-list")
    expect(list).toHaveTextContent("ts")
    expect(list).toHaveTextContent("boom")
    expect(list).toHaveTextContent("started")
  })

  it("refresh button reloads", async () => {
    const user = userEvent.setup()
    render(<LspLogsDialog open onOpenChange={() => {}} />)
    await screen.findByTestId("lsp-logs-dialog")
    await user.click(screen.getByRole("button", { name: "refreshAriaLabel" }))
    expect(loadLogsMock).toHaveBeenCalledTimes(2)
  })

  it("renders nothing when closed", () => {
    render(<LspLogsDialog open={false} onOpenChange={() => {}} />)
    expect(screen.queryByTestId("lsp-logs-dialog")).not.toBeInTheDocument()
    expect(loadLogsMock).not.toHaveBeenCalled()
  })
})

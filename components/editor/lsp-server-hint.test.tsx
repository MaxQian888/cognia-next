import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { LspServerHint } from "./lsp-server-hint"
import { useLspStatusStore, __resetLspStatusStoreForTesting } from "@/lib/lsp/lsp-status-store"
import type { LspServerStatus } from "@/types/lsp/config"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key} ${JSON.stringify(values)}` : key,
}))

// Settings store: no user servers — builtin defaults decide ownership.
jest.mock("@/stores/settings/settings-store", () => ({
  useSettingsStore: Object.assign(
    (selector: (s: unknown) => unknown) => selector({ settings: { lsp: { servers: [] } } }),
    { getState: () => ({ settings: { lsp: { servers: [] } } }) }
  ),
}))

const refreshMock = jest.fn(async () => {})
const installMock = jest.fn(async () => true)

function setStatus(status: Partial<LspServerStatus> & { serverId: string }) {
  useLspStatusStore.setState({
    statuses: {
      [status.serverId]: {
        install: "installed",
        health: "stopped",
        restarts: 0,
        ...status,
      } as LspServerStatus,
    },
  })
}

beforeEach(() => {
  __resetLspStatusStoreForTesting()
  refreshMock.mockClear()
  installMock.mockClear()
  useLspStatusStore.setState({ refresh: refreshMock, install: installMock })
})

describe("LspServerHint", () => {
  it("renders nothing when no status is known (web/mobile)", () => {
    render(<LspServerHint language="typescript" />)
    expect(screen.queryByTestId("lsp-server-hint")).not.toBeInTheDocument()
    // It still asks the store to populate itself once.
    expect(refreshMock).toHaveBeenCalled()
  })

  it("renders nothing for a healthy installed server", () => {
    setStatus({ serverId: "typescript", install: "managed", health: "running" })
    render(<LspServerHint language="typescript" />)
    expect(screen.queryByTestId("lsp-server-hint")).not.toBeInTheDocument()
  })

  it("renders nothing for a language no server owns", () => {
    setStatus({ serverId: "typescript", install: "missing" })
    render(<LspServerHint language="cobol" />)
    expect(screen.queryByTestId("lsp-server-hint")).not.toBeInTheDocument()
  })

  it("shows the missing hint with an Install button when npm metadata exists", async () => {
    const user = userEvent.setup()
    setStatus({
      serverId: "typescript",
      install: "missing",
      npmPackage: "typescript-language-server",
    })
    render(<LspServerHint language="typescript" />)
    expect(screen.getByTestId("lsp-server-hint")).toBeInTheDocument()
    await user.click(screen.getByTestId("lsp-server-hint-install"))
    expect(installMock).toHaveBeenCalledWith("typescript")
  })

  it("omits the Install button without npm metadata (e.g. rust-analyzer)", () => {
    setStatus({ serverId: "rust-analyzer", install: "missing" })
    render(<LspServerHint language="rust" />)
    expect(screen.getByTestId("lsp-server-hint")).toBeInTheDocument()
    expect(screen.queryByTestId("lsp-server-hint-install")).not.toBeInTheDocument()
  })

  it("shows the broken hint and dismisses per server", async () => {
    const user = userEvent.setup()
    setStatus({ serverId: "typescript", install: "managed", health: "broken" })
    render(<LspServerHint language="typescript" />)
    expect(screen.getByTestId("lsp-server-hint")).toHaveTextContent("broken")
    await user.click(screen.getByRole("button", { name: "dismissAriaLabel" }))
    expect(screen.queryByTestId("lsp-server-hint")).not.toBeInTheDocument()
  })

  it("disables the Install button while installing", () => {
    setStatus({
      serverId: "typescript",
      install: "missing",
      npmPackage: "typescript-language-server",
    })
    useLspStatusStore.setState({
      installProgress: { typescript: { serverId: "typescript", phase: "installing" } },
    })
    render(<LspServerHint language="typescript" />)
    expect(screen.getByTestId("lsp-server-hint-install")).toBeDisabled()
  })
})

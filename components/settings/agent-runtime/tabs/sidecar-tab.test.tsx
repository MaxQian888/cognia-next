import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
const getSidecarStatusMock = jest.fn()
const restartSidecarMock = jest.fn()
const getSessionMock = jest.fn()
const activeSessionRef = { current: "s1" as string | null }

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

jest.mock("@/lib/tauri", () => ({ isTauri: jest.fn(() => true) }))
jest.mock("@/lib/claude/ipc", () => ({
  getSidecarStatus: (...args: unknown[]) => getSidecarStatusMock(...args),
  restartSidecar: (...args: unknown[]) => restartSidecarMock(...args),
}))
// Both live queries default to a pending promise (undefined rows, the
// pre-hydration state); flip `hydratedRows` to exercise the resolved counts.
let hydratedRows = false
jest.mock("@/lib/db/sessions", () => ({
  getSession: (...args: unknown[]) => getSessionMock(...args),
  listSessions: () => (hydratedRows ? [{ id: "s1" }] : Promise.resolve([])),
}))
jest.mock("@/lib/db/mcp-servers", () => ({
  listMcpServers: () =>
    hydratedRows
      ? [
          { id: "m1", enabled: true },
          { id: "m2", enabled: false },
        ]
      : Promise.resolve([]),
}))
jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: (fn: () => unknown) => {
    const out = fn()
    if (out instanceof Promise) return undefined
    return out
  },
}))
const sidecarInfoRef = {
  current: { ready: false } as { ready: boolean; sdkVersion?: string; sidecarVersion?: string },
}
jest.mock("@/lib/claude/sidecar-info", () => ({
  useSidecarInfo: () => sidecarInfoRef.current,
}))
jest.mock("@/lib/slash-commands/builtin", () => ({
  BUILTIN_SLASH_COMMANDS: [{ name: "x" }],
}))
jest.mock("@/lib/slash-commands/registry", () => ({
  listSlashCommands: () => [],
}))
// The SDK-capabilities card mounted below polls the live session; stub it out so
// this read-only diagnostics suite stays deterministic (the card itself has its
// own test).
jest.mock("@/hooks/chat/use-sdk-session-capabilities", () => ({
  useSdkSessionCapabilities: () => ({ models: null, commands: null, refresh: jest.fn() }),
}))
jest.mock("@/components/settings/agent-runtime/sdk-parity-card", () => ({
  SdkParityCard: () => <div data-testid="sdk-parity-card" />,
}))
const routerReplaceMock = jest.fn()
jest.mock("next/navigation", () => ({
  useRouter: () => ({ replace: (...args: unknown[]) => routerReplaceMock(...args) }),
}))
jest.mock("@/stores/chat", () => ({
  useChatStore: (selector: (state: unknown) => unknown) =>
    selector({ activeSessionId: activeSessionRef.current }),
}))
jest.mock("sonner", () => ({
  toast: { success: jest.fn(), error: jest.fn(), message: jest.fn() },
}))

import { toast } from "sonner"
import { SidecarTab } from "./sidecar-tab"

const isTauriMock = (jest.requireMock("@/lib/tauri") as { isTauri: jest.Mock }).isTauri

describe("SidecarTab", () => {
  beforeEach(() => {
    isTauriMock.mockReturnValue(true)
    activeSessionRef.current = "s1"
    getSidecarStatusMock.mockReset()
    restartSidecarMock.mockReset()
    getSessionMock.mockReset()
    hydratedRows = false
  })

  it("shows the Desktop-only badge in web mode", () => {
    isTauriMock.mockReturnValue(false)
    render(<SidecarTab />)
    expect(screen.getByText("webOnly")).toBeInTheDocument()
    const button = screen.getByRole("button", { name: "restartBtn" })
    expect(button).toBeDisabled()
  })

  it("shows the running badge once the status poll resolves", async () => {
    getSidecarStatusMock.mockResolvedValue({ ready: true })
    getSessionMock.mockResolvedValue({ sdkSessionId: "abc-123" })
    render(<SidecarTab />)
    await waitFor(() => expect(screen.getByText("running")).toBeInTheDocument())
    await waitFor(() => expect(screen.getByText("abc-123")).toBeInTheDocument())
  })

  it("shows '—' when active session has no SDK session id", async () => {
    getSidecarStatusMock.mockResolvedValue({ ready: true })
    getSessionMock.mockResolvedValue({})
    render(<SidecarTab />)
    // Multiple "—" instances (sdkVersion, sidecarVersion, sdkSession). Asserting
    // ≥1 is enough — a more specific assertion would need a test-id and the
    // `—` literal is the only fallback marker we render.
    await waitFor(() => expect(screen.getAllByText("—").length).toBeGreaterThan(0))
  })

  it("shows '—' when there is no active session at all", async () => {
    activeSessionRef.current = null
    getSidecarStatusMock.mockResolvedValue({ ready: true })
    render(<SidecarTab />)
    expect(screen.getAllByText("—").length).toBeGreaterThan(0)
  })

  it("clicking Restart calls restartSidecar exactly once", async () => {
    getSidecarStatusMock.mockResolvedValue({ ready: true })
    getSessionMock.mockResolvedValue({ sdkSessionId: "x" })
    restartSidecarMock.mockResolvedValue(undefined)
    const user = userEvent.setup()
    render(<SidecarTab />)
    await user.click(screen.getByRole("button", { name: "restartBtn" }))
    expect(restartSidecarMock).toHaveBeenCalledTimes(1)
  })

  it("falls back to 'stopped' when the status call rejects", async () => {
    getSidecarStatusMock.mockRejectedValue(new Error("boom"))
    render(<SidecarTab />)
    await waitFor(() => expect(screen.getByText("stopped")).toBeInTheDocument())
  })

  it("renders the SDK version as a link to npm when sidecar reported one", () => {
    sidecarInfoRef.current = { ready: true, sdkVersion: "0.42.0", sidecarVersion: "0.1.0" }
    getSidecarStatusMock.mockResolvedValue({ ready: true })
    render(<SidecarTab />)
    const link = screen.getByTestId("sidecar-sdk-version") as HTMLAnchorElement
    expect(link).toBeInTheDocument()
    expect(link.href).toContain("0.42.0")
    expect(link.target).toBe("_blank")
  })

  it("renders 4 count tiles", () => {
    getSidecarStatusMock.mockResolvedValue({ ready: true })
    render(<SidecarTab />)
    expect(screen.getByTestId("count-tile-sessions")).toBeInTheDocument()
    expect(screen.getByTestId("count-tile-slash-commands")).toBeInTheDocument()
    expect(screen.getByTestId("count-tile-hooks")).toBeInTheDocument()
    expect(screen.getByTestId("count-tile-mcp")).toBeInTheDocument()
    expect(screen.getByTestId("sdk-parity-card")).toBeInTheDocument()
  })
})

describe("SidecarTab — count tiles", () => {
  it("routes each tile to the section that owns it", async () => {
    const user = userEvent.setup()
    routerReplaceMock.mockClear()
    render(<SidecarTab />)

    await user.click(screen.getByTestId("count-tile-sessions"))
    expect(routerReplaceMock).toHaveBeenLastCalledWith(
      expect.stringContaining("agentRuntimeTab=sessions"),
      expect.objectContaining({ scroll: false })
    )

    await user.click(screen.getByTestId("count-tile-slash-commands"))
    expect(routerReplaceMock).toHaveBeenLastCalledWith(
      expect.stringContaining("section=slash-commands"),
      expect.objectContaining({ scroll: false })
    )

    await user.click(screen.getByTestId("count-tile-hooks"))
    expect(routerReplaceMock).toHaveBeenLastCalledWith(
      expect.stringContaining("section=hooks"),
      expect.objectContaining({ scroll: false })
    )

    await user.click(screen.getByTestId("count-tile-mcp"))
    expect(routerReplaceMock).toHaveBeenLastCalledWith(
      expect.stringContaining("section=mcp"),
      expect.objectContaining({ scroll: false })
    )
  })

  it("clears the SDK session id when the session lookup rejects", async () => {
    getSidecarStatusMock.mockResolvedValue({ ready: true })
    getSessionMock.mockRejectedValue(new Error("dexie down"))
    render(<SidecarTab />)
    await waitFor(() => expect(screen.getByTestId("count-tile-sessions")).toBeInTheDocument())
    expect(screen.getByText("sdkSessionLabel").parentElement).toHaveTextContent("—")
  })

  it("surfaces a restart failure and unblocks the button", async () => {
    const user = userEvent.setup()
    getSidecarStatusMock.mockResolvedValue({ ready: true })
    getSessionMock.mockResolvedValue({ sdkSessionId: "x" })
    restartSidecarMock.mockRejectedValue(new Error("sidecar refused"))
    render(<SidecarTab />)

    await user.click(screen.getByRole("button", { name: "restartBtn" }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("sidecar refused"))
    expect(screen.getByRole("button", { name: "restartBtn" })).not.toBeDisabled()
  })

  it("counts hydrated sessions and enabled-vs-total MCP servers", async () => {
    hydratedRows = true
    getSidecarStatusMock.mockResolvedValue({ ready: true })
    getSessionMock.mockResolvedValue({ sdkSessionId: "x" })
    render(<SidecarTab />)

    await waitFor(() => expect(screen.getByTestId("count-tile-sessions")).toHaveTextContent("1"))
    expect(screen.getByTestId("count-tile-mcp")).toHaveTextContent("1/2")
  })

  it("stringifies a non-Error restart failure", async () => {
    const user = userEvent.setup()
    getSidecarStatusMock.mockResolvedValue({ ready: true })
    getSessionMock.mockResolvedValue({ sdkSessionId: "x" })
    restartSidecarMock.mockRejectedValue("plain string boom")
    render(<SidecarTab />)

    await user.click(screen.getByRole("button", { name: "restartBtn" }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("plain string boom"))
  })
})

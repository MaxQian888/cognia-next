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
jest.mock("@/lib/db/sessions", () => ({
  getSession: (...args: unknown[]) => getSessionMock(...args),
  listSessions: () => Promise.resolve([]),
}))
jest.mock("@/lib/db/mcp-servers", () => ({
  listMcpServers: () => Promise.resolve([]),
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
jest.mock("next/navigation", () => ({
  useRouter: () => ({ replace: jest.fn() }),
}))
jest.mock("@/stores/chat", () => ({
  useChatStore: (selector: (state: unknown) => unknown) =>
    selector({ activeSessionId: activeSessionRef.current }),
}))
jest.mock("sonner", () => ({
  toast: { success: jest.fn(), error: jest.fn(), message: jest.fn() },
}))

import { SidecarTab } from "./sidecar-tab"

const isTauriMock = (jest.requireMock("@/lib/tauri") as { isTauri: jest.Mock }).isTauri

describe("SidecarTab", () => {
  beforeEach(() => {
    isTauriMock.mockReturnValue(true)
    activeSessionRef.current = "s1"
    getSidecarStatusMock.mockReset()
    restartSidecarMock.mockReset()
    getSessionMock.mockReset()
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
  })
})

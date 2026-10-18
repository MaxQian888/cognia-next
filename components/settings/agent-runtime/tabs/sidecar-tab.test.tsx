import { act, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
const getSidecarStatusMock = jest.fn()
const restartSidecarMock = jest.fn()
const getSessionMock = jest.fn()
const updateSessionMock = jest.fn().mockResolvedValue(undefined)
const activeSessionRef = { current: "s1" as string | null }
const executionHandleRef = {
  current: null as null | {
    reloadExtensions?: jest.Mock
    spec?: { capabilities: { effective: string[] } }
    reloadPlugins: jest.Mock<Promise<unknown>, []>
    reloadSkills: jest.Mock<Promise<unknown>, []>
    reinitialize: jest.Mock<Promise<unknown>, []>
  },
}

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
  updateSession: (...args: unknown[]) => updateSessionMock(...args),
  // One open conversation plus rows the count must skip: an archived
  // conversation and embedded subagent / workflow-editor sessions.
  listSessions: () =>
    hydratedRows
      ? [
          { id: "s1" },
          { id: "s2", archivedAt: 5 },
          { id: "sub", kind: "subagent" },
          { id: "wf", kind: "workflow-editor" },
          { id: "hidden", visibility: "embedded" },
        ]
      : Promise.resolve([]),
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
jest.mock("@/components/providers/agent-execution-handle-provider", () => ({
  useAgentExecutionHandle: () => executionHandleRef.current,
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
    updateSessionMock.mockReset().mockResolvedValue(undefined)
    hydratedRows = false
    executionHandleRef.current = null
    jest.mocked(toast.error).mockClear()
    jest.mocked(toast.success).mockClear()
  })

  it.each(["applied", "held", "partial"])(
    "loads a portable extension and presents its %s disposition",
    async (disposition) => {
      const user = userEvent.setup()
      const added = [{ kind: "directory", path: "/workspace/plugin", discoverMcp: false }]
      const reloadExtensions = jest
        .fn()
        .mockResolvedValue({ disposition, added: disposition === "held" ? [] : added })
      executionHandleRef.current = {
        spec: { capabilities: { effective: ["extensions.dynamic"] } },
        reloadExtensions,
        reloadPlugins: jest.fn(),
        reloadSkills: jest.fn(),
        reinitialize: jest.fn(),
      }
      getSessionMock.mockResolvedValue({ runtimeExtensions: [] })
      render(<SidecarTab />)
      await user.type(screen.getByRole("textbox", { name: "extensionPath" }), "/workspace/plugin")
      await user.click(screen.getByRole("button", { name: "addExtension" }))
      expect(reloadExtensions).toHaveBeenCalledWith({
        add: [{ kind: "directory", path: "/workspace/plugin" }],
        preservePromptCache: true,
      })
      expect(await screen.findByText(`extensionResult.${disposition}`)).toBeInTheDocument()
      if (disposition === "held") expect(updateSessionMock).not.toHaveBeenCalled()
      else expect(updateSessionMock).toHaveBeenCalledWith("s1", { runtimeExtensions: added })
      if (disposition === "held")
        expect(screen.queryByText("/workspace/plugin")).not.toBeInTheDocument()
      else expect(screen.getByText("/workspace/plugin")).toBeInTheDocument()
    }
  )

  it("restores saved extensions and removes one when the active runtime has no support", async () => {
    const user = userEvent.setup()
    const refs = [
      { kind: "directory", path: "/workspace/first", discoverMcp: false },
      { kind: "directory", path: "/workspace/second", discoverMcp: false },
    ]
    getSessionMock.mockResolvedValue({ runtimeExtensions: refs })
    render(<SidecarTab />)
    const first = await screen.findByText("/workspace/first")
    expect(screen.getByText("extensionsRemovalHint")).toBeInTheDocument()
    await user.click(within(first.closest("li")!).getByRole("button", { name: "removeExtension" }))
    expect(updateSessionMock).toHaveBeenCalledWith("s1", { runtimeExtensions: [refs[1]] })
    await waitFor(() => expect(screen.queryByText("/workspace/first")).not.toBeInTheDocument())
    expect(screen.getByText("/workspace/second")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "addExtension" })).toBeDisabled()
    expect(screen.getByText("extensionsRemoved")).toBeInTheDocument()
  })

  it("clears saved extensions through session metadata even in web mode", async () => {
    const user = userEvent.setup()
    isTauriMock.mockReturnValue(false)
    getSessionMock.mockResolvedValue({
      runtimeExtensions: [{ kind: "directory", path: "/workspace/saved" }],
    })
    render(<SidecarTab />)
    await screen.findByText("/workspace/saved")
    await user.click(screen.getByRole("button", { name: "clearExtensions" }))
    expect(updateSessionMock).toHaveBeenCalledWith("s1", { runtimeExtensions: [] })
    await waitFor(() => expect(screen.queryByText("/workspace/saved")).not.toBeInTheDocument())
  })

  it("retains the saved list and surfaces a failed removal", async () => {
    const user = userEvent.setup()
    getSessionMock.mockResolvedValue({
      runtimeExtensions: [{ kind: "directory", path: "/workspace/saved" }],
    })
    updateSessionMock.mockRejectedValue(new Error("database unavailable"))
    render(<SidecarTab />)
    await screen.findByText("/workspace/saved")
    await user.click(screen.getByRole("button", { name: "clearExtensions" }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("database unavailable"))
    expect(screen.getByText("/workspace/saved")).toBeInTheDocument()
    expect(screen.queryByText("extensionsRemoved")).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: "clearExtensions" })).not.toBeDisabled()
  })

  it("does not claim an acknowledged addition was saved when persistence fails", async () => {
    const user = userEvent.setup()
    executionHandleRef.current = {
      spec: { capabilities: { effective: ["extensions.dynamic"] } },
      reloadExtensions: jest.fn().mockResolvedValue({
        disposition: "applied",
        added: [{ kind: "directory", path: "/workspace/plugin" }],
      }),
      reloadPlugins: jest.fn(),
      reloadSkills: jest.fn(),
      reinitialize: jest.fn(),
    }
    getSessionMock.mockResolvedValue({ runtimeExtensions: [] })
    updateSessionMock.mockRejectedValue(new Error("database unavailable"))
    render(<SidecarTab />)
    await user.type(screen.getByRole("textbox", { name: "extensionPath" }), "/workspace/plugin")
    await user.click(screen.getByRole("button", { name: "addExtension" }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("database unavailable"))
    expect(screen.queryByText("extensionResult.applied")).not.toBeInTheDocument()
    expect(screen.queryByText("/workspace/plugin")).not.toBeInTheDocument()
  })

  it.each(["applied", "held"])(
    "handles an initial saved-ref read that completes after an %s addition",
    async (disposition) => {
      const user = userEvent.setup()
      let resolveInitial!: (value: unknown) => void
      const initial = new Promise((resolve) => {
        resolveInitial = resolve
      })
      getSessionMock.mockReturnValueOnce(initial).mockResolvedValue({ runtimeExtensions: [] })
      executionHandleRef.current = {
        spec: { capabilities: { effective: ["extensions.dynamic"] } },
        reloadExtensions: jest.fn().mockResolvedValue({
          disposition,
          added: disposition === "held" ? [] : [{ kind: "directory", path: "/workspace/plugin" }],
        }),
        reloadPlugins: jest.fn(),
        reloadSkills: jest.fn(),
        reinitialize: jest.fn(),
      }
      render(<SidecarTab />)
      await user.type(screen.getByRole("textbox", { name: "extensionPath" }), "/workspace/plugin")
      await user.click(screen.getByRole("button", { name: "addExtension" }))
      await screen.findByText(`extensionResult.${disposition}`)
      await act(async () =>
        resolveInitial({
          runtimeExtensions: [{ kind: "directory", path: "/workspace/initial" }],
        })
      )
      if (disposition === "held") {
        expect(screen.getByText("/workspace/initial")).toBeInTheDocument()
        expect(screen.queryByText("/workspace/plugin")).not.toBeInTheDocument()
      } else {
        expect(screen.getByText("/workspace/plugin")).toBeInTheDocument()
        expect(screen.queryByText("/workspace/initial")).not.toBeInTheDocument()
      }
    }
  )

  it("ignores a stale session read after switching conversations", async () => {
    let resolveOld!: (value: unknown) => void
    getSessionMock.mockImplementation((id: string) =>
      id === "s1"
        ? new Promise((resolve) => {
            resolveOld = resolve
          })
        : Promise.resolve({
            runtimeExtensions: [{ kind: "directory", path: "/workspace/current" }],
          })
    )
    const { rerender } = render(<SidecarTab />)
    activeSessionRef.current = "s2"
    rerender(<SidecarTab />)
    await screen.findByText("/workspace/current")
    await act(async () =>
      resolveOld({ runtimeExtensions: [{ kind: "directory", path: "/workspace/old" }] })
    )
    expect(screen.queryByText("/workspace/old")).not.toBeInTheDocument()
    expect(screen.getByText("/workspace/current")).toBeInTheDocument()
  })

  it("disables live additions unless the active runtime advertises support", () => {
    executionHandleRef.current = {
      spec: { capabilities: { effective: [] } },
      reloadPlugins: jest.fn(),
      reloadSkills: jest.fn(),
      reinitialize: jest.fn(),
    }
    render(<SidecarTab />)
    expect(screen.getByRole("button", { name: "addExtension" })).toBeDisabled()
    expect(screen.getByText("extensionsUnsupported")).toBeInTheDocument()
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

  it("routes live capability mutations through the active execution handle", async () => {
    const user = userEvent.setup()
    const reloadPlugins = jest.fn().mockResolvedValue(undefined)
    const reloadSkills = jest.fn().mockResolvedValue(undefined)
    const reinitialize = jest.fn().mockResolvedValue(undefined)
    executionHandleRef.current = { reloadPlugins, reloadSkills, reinitialize }
    getSidecarStatusMock.mockResolvedValue({ ready: true })
    getSessionMock.mockResolvedValue({ sdkSessionId: "sdk-1" })

    render(<SidecarTab />)
    await user.click(screen.getByRole("button", { name: "reloadPluginsBtn" }))
    await user.click(screen.getByRole("button", { name: "reloadSkillsBtn" }))
    await user.click(screen.getByRole("button", { name: "reinitializeBtn" }))

    expect(reloadPlugins).toHaveBeenCalledTimes(1)
    expect(reloadSkills).toHaveBeenCalledTimes(1)
    expect(reinitialize).toHaveBeenCalledTimes(1)
    expect(toast.success).toHaveBeenCalledWith("capabilityActionSucceeded")
  })

  it("disables live capability mutations when Chat has no registered handle", () => {
    getSidecarStatusMock.mockResolvedValue({ ready: true })
    render(<SidecarTab />)

    expect(screen.getByRole("button", { name: "reloadPluginsBtn" })).toBeDisabled()
    expect(screen.getByRole("button", { name: "reloadSkillsBtn" })).toBeDisabled()
    expect(screen.getByRole("button", { name: "reinitializeBtn" })).toBeDisabled()
  })

  it("surfaces a live capability mutation failure and unblocks the controls", async () => {
    const user = userEvent.setup()
    const reloadPlugins = jest.fn().mockRejectedValue(new Error("reload refused"))
    executionHandleRef.current = {
      reloadPlugins,
      reloadSkills: jest.fn().mockResolvedValue(undefined),
      reinitialize: jest.fn().mockResolvedValue(undefined),
    }
    getSidecarStatusMock.mockResolvedValue({ ready: true })

    render(<SidecarTab />)
    await user.click(screen.getByRole("button", { name: "reloadPluginsBtn" }))

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("reload refused"))
    expect(screen.getByRole("button", { name: "reloadPluginsBtn" })).not.toBeDisabled()
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

  it("marks the counts strip as a hairline grid whose children are the four tiles", () => {
    // Over a wallpaper the grid becomes one translucent plate and the cells go
    // clear (globals.css `[data-hairline-grid] > *`), so the marker must sit on
    // the grid whose direct children are the count tiles.
    getSidecarStatusMock.mockResolvedValue({ ready: true })
    render(<SidecarTab />)

    const strip = screen.getByTestId("count-tile-sessions").parentElement
    expect(strip).toHaveAttribute("data-hairline-grid")
    expect(
      Array.from(strip?.children ?? []).map((cell) => cell.getAttribute("data-testid"))
    ).toEqual([
      "count-tile-sessions",
      "count-tile-slash-commands",
      "count-tile-hooks",
      "count-tile-mcp",
    ])
    expect(strip?.children[0]).toHaveTextContent("countSessions")
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

  it("counts active exposed conversations and enabled-vs-total MCP servers", async () => {
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

/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent, waitFor } from "@testing-library/react"

const mockUseMediaQuery = jest.fn((_query: string) => false)
const mockResizableLayout = jest.fn((_key: string) => ({
  defaultLayout: undefined,
  onLayoutChanged: jest.fn(),
}))
jest.mock("@/hooks/ui", () => ({
  useMediaQuery: (query: string) => mockUseMediaQuery(query),
  useResizableLayout: (key: string) => mockResizableLayout(key),
}))

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

const routerBack = jest.fn()
jest.mock("next/navigation", () => ({
  useRouter: () => ({ back: routerBack, push: jest.fn() }),
}))

const mockSpawnFromDock = jest.fn(async () => ({
  kind: "spawned" as const,
  sessionId: "s-new",
  shell: "/bin/bash",
}))
const mockDetachFromDock = jest.fn(async () => undefined)
const mockAccessoryInput = jest.fn(async () => undefined)
const mockAccessoryPaste = jest.fn(async () => undefined)
const mockKeyboardFocus = jest.fn()
const mockKeyboardHide = jest.fn()
const mockRehydrateTerminals = jest.fn(async () => ({ restored: 0, failed: 0 }))

jest.mock("@/lib/terminal/rehydrate", () => ({
  rehydrateTerminals: () => mockRehydrateTerminals(),
}))
jest.mock("@/lib/terminal/spawn-orchestrator", () => ({
  spawnFromDock: (...args: unknown[]) => mockSpawnFromDock(...(args as [])),
  detachFromDock: (...args: unknown[]) => mockDetachFromDock(...(args as [])),
}))

// Skip the heavy xterm path — the instance is mounted but the wrapper
// returns a div placeholder so we focus on the screen-level wiring.
jest.mock("@/components/terminal/terminal-instance", () => {
  const React = jest.requireActual<typeof import("react")>("react")
  const TerminalInstanceStub = React.forwardRef<
    unknown,
    { sessionId: string; fontSize?: number; scrollback?: number }
  >(({ sessionId, fontSize, scrollback }, ref) => {
    React.useImperativeHandle(ref, () => ({
      sendInput: mockAccessoryInput,
      pasteFromClipboard: mockAccessoryPaste,
      focusKeyboard: mockKeyboardFocus,
      hideKeyboard: mockKeyboardHide,
    }))
    return (
      <div
        data-testid="terminal-instance-stub"
        data-session-id={sessionId}
        data-font-size={fontSize}
        data-scrollback={scrollback}
      />
    )
  })
  TerminalInstanceStub.displayName = "TerminalInstanceStub"
  return { TerminalInstance: TerminalInstanceStub }
})
jest.mock("@/components/mobile/connection-state-badge", () => ({
  ConnectionStateBadge: () => <div data-testid="connection-state-badge-stub" />,
}))
jest.mock("@/components/artifacts/workspace-mode/project-overview-panel", () => ({
  ProjectOverviewPanel: ({ projectId }: { projectId: string }) => (
    <div data-testid="project-overview-stub" data-project-id={projectId} />
  ),
}))

// Wave 2 — search + history overlays mounted on the mobile screen.
// Stubbed to surface deterministic markers without standing up the
// full xterm search addon / store-bound history rail.
jest.mock("@/components/terminal/terminal-search-overlay", () => ({
  TerminalSearchOverlay: ({ open }: { open: boolean }) =>
    open ? <div data-testid="terminal-search-overlay-stub" /> : null,
}))
jest.mock("@/components/terminal/terminal-history-panel", () => ({
  TerminalHistoryPanel: ({ sessionId }: { sessionId: string }) => (
    <div data-testid="terminal-history-panel-stub" data-session-id={sessionId} />
  ),
}))
jest.mock("@/components/terminal/terminal-forward-panel", () => ({
  TerminalForwardPanel: ({ sessionId }: { sessionId: string }) => (
    <div data-testid="terminal-forward-panel-stub" data-session-id={sessionId} />
  ),
}))

// Force transport selection so tests are deterministic.
let mockTransport: "ws" | "tauri-channel" | "unsupported" = "ws"
jest.mock("@/lib/terminal/pick-transport", () => ({
  selectTerminalTransport: () => mockTransport,
  selectTerminalTransportChain: () => (mockTransport === "unsupported" ? [] : [mockTransport]),
}))

import userEvent from "@testing-library/user-event"

import { MobileTerminalScreen } from "./mobile-terminal-screen"
import { useTerminalStore } from "@/stores/terminal/terminal-store"
import { useProjectStore } from "@/stores/project/project-store"
import { useSettingsStore } from "@/stores/settings"
import type { SessionInfo } from "@/lib/terminal/types"

function info(overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id: "s-1",
    projectId: "proj-a",
    extensionId: null,
    origin: "remote",
    shell: "/bin/bash",
    ...overrides,
  }
}

beforeEach(() => {
  useTerminalStore.getState().reset()
  useProjectStore.setState({ projects: [], activeProjectId: "proj-a" })
  useSettingsStore.setState({ settings: null })
  mockSpawnFromDock.mockClear()
  mockDetachFromDock.mockClear()
  mockAccessoryInput.mockClear()
  mockAccessoryPaste.mockClear()
  mockKeyboardFocus.mockClear()
  mockKeyboardHide.mockClear()
  mockRehydrateTerminals.mockClear()
  routerBack.mockClear()
  mockTransport = "ws"
  mockUseMediaQuery.mockReset().mockReturnValue(false)
  mockResizableLayout.mockClear()
})

describe("MobileTerminalScreen", () => {
  it("restores host-owned sessions when the mobile terminal opens", async () => {
    render(<MobileTerminalScreen />)
    await waitFor(() => expect(mockRehydrateTerminals).toHaveBeenCalledTimes(1))
  })

  it("renders the empty state with action button when ws transport and no sessions", () => {
    render(<MobileTerminalScreen />)
    expect(screen.getByTestId("mobile-terminal-empty")).toBeInTheDocument()
    expect(screen.getByText("empty.remoteReady")).toBeInTheDocument()
  })

  it("renders the tab strip + instance when a session exists", () => {
    useTerminalStore.getState().registerSession(info())
    render(<MobileTerminalScreen />)
    expect(screen.getByTestId("mobile-terminal-tabs")).toBeInTheDocument()
    expect(screen.getByTestId("terminal-instance-stub")).toHaveAttribute("data-session-id", "s-1")
  })

  it("falls back to the phone-sized font/scrollback when the user set none", () => {
    useTerminalStore.getState().registerSession(info())
    render(<MobileTerminalScreen />)
    const stub = screen.getByTestId("terminal-instance-stub")
    expect(stub).toHaveAttribute("data-font-size", "11")
    expect(stub).toHaveAttribute("data-scrollback", "5000")
  })

  // Regression: the phone-sized values used to be hard pins, so Settings →
  // Terminal → Font size had no effect at all on mobile.
  it("honors the configured terminal font size and scrollback", () => {
    useSettingsStore.setState({
      settings: { terminal: { fontSize: 17, scrollback: 20000 } },
    } as never)
    useTerminalStore.getState().registerSession(info())
    render(<MobileTerminalScreen />)
    const stub = screen.getByTestId("terminal-instance-stub")
    expect(stub).toHaveAttribute("data-font-size", "17")
    expect(stub).toHaveAttribute("data-scrollback", "20000")
  })

  it("calls spawnFromDock when + New is tapped", () => {
    render(<MobileTerminalScreen />)
    fireEvent.click(screen.getByTestId("mobile-terminal-new"))
    expect(mockSpawnFromDock).toHaveBeenCalled()
  })

  /**
   * A phone could not open an SSH session because nothing on it offered to,
   * not because it could not. The host resolves the profile id against its own
   * `ssh_profiles` map and dials with credentials that never leave it.
   */
  it("offers saved SSH hosts behind the shell picker", async () => {
    useSettingsStore.setState({
      settings: {
        terminal: {
          sshHosts: [
            {
              id: "ssh-1",
              name: "Production",
              host: "prod.example.com",
              port: 22,
              username: "deploy",
              authMethod: "agent",
            },
          ],
        },
      },
    } as never)
    render(<MobileTerminalScreen />)
    // Radix opens on pointerdown, which `fireEvent.click` does not send.
    await userEvent.click(screen.getByTestId("mobile-terminal-shell-picker"))
    expect(await screen.findByTestId("terminal-shell-picker-ssh-ssh-1")).toBeInTheDocument()
  })

  /**
   * One tap is the primary action on this screen. Collapsing the split into a
   * menu button would trade it for a list the user usually does not need.
   */
  it("still spawns a default session on the first tap", () => {
    render(<MobileTerminalScreen />)
    fireEvent.click(screen.getByTestId("mobile-terminal-new"))
    expect(mockSpawnFromDock).toHaveBeenCalled()
  })

  it("back button calls router.back", () => {
    render(<MobileTerminalScreen />)
    fireEvent.click(screen.getByTestId("mobile-terminal-back"))
    expect(routerBack).toHaveBeenCalled()
  })

  it("shows the connection-state badge", () => {
    render(<MobileTerminalScreen />)
    expect(screen.getByTestId("connection-state-badge-stub")).toBeInTheDocument()
  })

  it("renders the desktop empty-state copy when running outside ws transport", () => {
    mockTransport = "tauri-channel"
    render(<MobileTerminalScreen />)
    expect(screen.getByText("empty.notMobile")).toBeInTheDocument()
  })

  it("renders the unavailable copy in plain browser", () => {
    mockTransport = "unsupported"
    render(<MobileTerminalScreen />)
    expect(screen.getByText("empty.unavailable")).toBeInTheDocument()
  })

  it("detaches without terminating when a tab close is tapped", () => {
    useTerminalStore.getState().registerSession(info())
    render(<MobileTerminalScreen />)
    fireEvent.click(screen.getByLabelText("close"))
    expect(mockDetachFromDock).toHaveBeenCalled()
  })

  it("provides touch keys, paste, and explicit software-keyboard control", () => {
    useTerminalStore.getState().registerSession(info())
    render(<MobileTerminalScreen />)
    expect(screen.getByTestId("mobile-terminal-accessory")).toBeInTheDocument()
    fireEvent.click(screen.getByLabelText("accessory.up"))
    fireEvent.click(screen.getByLabelText("accessory.paste"))
    fireEvent.click(screen.getByLabelText("accessory.showKeyboard"))
    fireEvent.click(screen.getByLabelText("accessory.hideKeyboard"))
    expect(mockAccessoryInput).toHaveBeenCalledWith("\u001b[A")
    expect(mockAccessoryPaste).toHaveBeenCalled()
    expect(mockKeyboardFocus).toHaveBeenCalled()
    expect(mockKeyboardHide).toHaveBeenCalled()
  })

  it("uses the persisted portrait or landscape workbench split on tablets", () => {
    mockUseMediaQuery.mockImplementation((query) => query.includes("min-width"))
    useProjectStore.setState({ projects: [{ id: "proj-a" }] as never, activeProjectId: "proj-a" })
    const { unmount } = render(<MobileTerminalScreen />)
    expect(screen.getByTestId("tablet-terminal-split")).toBeInTheDocument()
    expect(screen.getByTestId("project-overview-stub")).toHaveAttribute("data-project-id", "proj-a")
    expect(mockResizableLayout).toHaveBeenCalledWith("cognia-tablet-terminal-portrait")

    unmount()
    mockUseMediaQuery.mockReturnValue(true)
    render(<MobileTerminalScreen />)
    expect(mockResizableLayout).toHaveBeenCalledWith("cognia-tablet-terminal-landscape")
  })

  describe("Wave 2 — overlay parity", () => {
    it("search + history buttons are disabled when no session is active", () => {
      render(<MobileTerminalScreen />)
      expect(screen.getByTestId("mobile-terminal-search")).toBeDisabled()
      expect(screen.getByTestId("mobile-terminal-history")).toBeDisabled()
    })

    it("clicking the search button toggles the search overlay open", () => {
      useTerminalStore.getState().registerSession(info())
      render(<MobileTerminalScreen />)
      expect(screen.queryByTestId("terminal-search-overlay-stub")).not.toBeInTheDocument()
      fireEvent.click(screen.getByTestId("mobile-terminal-search"))
      expect(screen.getByTestId("terminal-search-overlay-stub")).toBeInTheDocument()
    })

    it("clicking the history button opens the slide-up sheet with the active session", () => {
      useTerminalStore.getState().registerSession(info())
      render(<MobileTerminalScreen />)
      expect(screen.queryByTestId("terminal-history-panel-stub")).not.toBeInTheDocument()
      fireEvent.click(screen.getByTestId("mobile-terminal-history"))
      const panel = screen.getByTestId("terminal-history-panel-stub")
      expect(panel).toHaveAttribute("data-session-id", "s-1")
    })
  })
})

/**
 * A phone can open an SSH tab (the host resolves the profile id and connects),
 * so it can have tunnels. The rail is the only surface that names them, and it
 * was mounted on the desktop dock only.
 */
it("gives the active tab a port-forward rail", async () => {
  mockTransport = "ws"
  useTerminalStore.getState().registerSession(info())
  render(<MobileTerminalScreen />)
  const rail = await screen.findByTestId("terminal-forward-panel-stub")
  expect(rail.getAttribute("data-session-id")).toBe("s-1")
})

/**
 * The picker has listed saved profiles since it was written. The phone was the
 * one caller that never passed them, so a profile configured on the desktop was
 * invisible on the device most likely to want a one-tap launch.
 */
it("offers saved launch profiles behind the shell picker", async () => {
  mockTransport = "ws"
  useSettingsStore.setState({
    settings: {
      terminal: {
        profiles: [{ id: "prof-1", name: "Deploy box", shell: "/bin/bash" }],
      },
    },
  } as never)
  render(<MobileTerminalScreen />)
  await userEvent.click(screen.getByTestId("mobile-terminal-shell-picker"))
  await userEvent.click(await screen.findByTestId("terminal-shell-picker-profile-prof-1"))

  await waitFor(() => expect(mockSpawnFromDock).toHaveBeenCalled())
  // Only the id travels: the host resolves shell, cwd and env from its own
  // synchronized copy, the same contract a remote spawn frame has.
  const req = mockSpawnFromDock.mock.calls.at(-1)?.[0] as { req: Record<string, unknown> }
  expect(req.req.profileId).toBe("prof-1")
  expect(req.req.shell).toBe("")
})

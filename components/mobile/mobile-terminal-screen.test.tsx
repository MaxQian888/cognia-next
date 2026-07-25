/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent } from "@testing-library/react"

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
const mockKillFromDock = jest.fn(async () => undefined)
jest.mock("@/lib/terminal/spawn-orchestrator", () => ({
  spawnFromDock: (...args: unknown[]) => mockSpawnFromDock(...(args as [])),
  killFromDock: (...args: unknown[]) => mockKillFromDock(...(args as [])),
}))

// Skip the heavy xterm path — the instance is mounted but the wrapper
// returns a div placeholder so we focus on the screen-level wiring.
jest.mock("@/components/terminal/terminal-instance", () => ({
  TerminalInstance: ({
    sessionId,
    fontSize,
    scrollback,
  }: {
    sessionId: string
    fontSize?: number
    scrollback?: number
  }) => (
    <div
      data-testid="terminal-instance-stub"
      data-session-id={sessionId}
      data-font-size={fontSize}
      data-scrollback={scrollback}
    />
  ),
}))
jest.mock("@/components/mobile/connection-state-badge", () => ({
  ConnectionStateBadge: () => <div data-testid="connection-state-badge-stub" />,
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

// Force transport selection so tests are deterministic.
let mockTransport: "ws" | "tauri-channel" | "unsupported" = "ws"
jest.mock("@/lib/terminal/pick-transport", () => ({
  selectTerminalTransport: () => mockTransport,
}))

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
  mockKillFromDock.mockClear()
  routerBack.mockClear()
  mockTransport = "ws"
})

describe("MobileTerminalScreen", () => {
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

  it("calls killFromDock when a tab close is tapped", () => {
    useTerminalStore.getState().registerSession(info())
    render(<MobileTerminalScreen />)
    fireEvent.click(screen.getByLabelText("close"))
    expect(mockKillFromDock).toHaveBeenCalled()
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

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
  TerminalInstance: ({ sessionId }: { sessionId: string }) => (
    <div data-testid="terminal-instance-stub" data-session-id={sessionId} />
  ),
}))
jest.mock("@/components/mobile/connection-state-badge", () => ({
  ConnectionStateBadge: () => <div data-testid="connection-state-badge-stub" />,
}))

// Force transport selection so tests are deterministic.
let mockTransport: "ws" | "tauri-channel" | "unsupported" = "ws"
jest.mock("@/lib/terminal/pick-transport", () => ({
  selectTerminalTransport: () => mockTransport,
}))

import { MobileTerminalScreen } from "./mobile-terminal-screen"
import { useTerminalStore } from "@/stores/terminal/terminal-store"
import { useProjectStore } from "@/stores/project/project-store"
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
})

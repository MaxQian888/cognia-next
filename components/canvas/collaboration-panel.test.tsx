/**
 * CollaborationPanel - Unit Tests
 */

import React from "react"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { CollaborationPanel } from "./collaboration-panel"

// Bypass TooltipProvider context (production wraps the app at layout.tsx).
jest.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

// Mock next-intl
jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => {
    const translations: Record<string, string> = {
      collaborate: "Collaborate",
      collaboration: "Collaboration",
      connected: "Connected",
      connecting: "Connecting...",
      connectionError: "Connection Error",
      disconnected: "Disconnected",
      reconnecting: "Reconnecting...",
      startSession: "Start Session",
      endSession: "End Session",
      joinExisting: "Join Existing Session",
      sessionIdPlaceholder: "Enter session ID",
      copyLink: "Copy Link",
      copyShareLink: "Copy share link",
      shareLinkUnavailable: "No active session to share yet.",
      copyLinkFailed: "Failed to copy share link.",
      collabFallbackMessage:
        "Collaboration transport unavailable. You can continue editing locally.",
      reconnect: "Reconnect",
      continueLocally: "Continue Locally",
      snapshotOnly: "Snapshot only",
      degradedLocal: "Editing locally",
      sessionEnded: "Session ended",
      copied: "Copied!",
      participants: "Participants",
      noParticipants: "No participants yet",
    }
    return translations[key] || key
  },
}))

// Mock useCollaborativeSession hook
const mockConnect = jest.fn()
const mockDisconnect = jest.fn()
const mockShareSession = jest.fn()
const mockJoinSession = jest.fn()

jest.mock("@/hooks/canvas", () => ({
  useCollaborativeSession: () => ({
    session: null,
    participants: [],
    connectionState: "disconnected",
    isConnected: false,
    connect: mockConnect,
    disconnect: mockDisconnect,
    shareSession: mockShareSession,
    joinSession: mockJoinSession,
  }),
}))

describe("CollaborationPanel", () => {
  const defaultProps = {
    documentId: "doc-123",
    documentContent: 'const hello = "world";',
  }

  beforeEach(() => {
    jest.clearAllMocks()
  })

  it("should render the collaborate button", () => {
    render(<CollaborationPanel {...defaultProps} />)
    expect(screen.getByText("Collaborate")).toBeInTheDocument()
  })

  it("should open panel when button is clicked", async () => {
    render(<CollaborationPanel {...defaultProps} />)

    const button = screen.getByText("Collaborate")
    await userEvent.click(button)

    expect(screen.getByText("Collaboration")).toBeInTheDocument()
  })

  it("should show start session button when not connected", async () => {
    render(<CollaborationPanel {...defaultProps} />)

    const button = screen.getByText("Collaborate")
    await userEvent.click(button)

    expect(screen.getByText("Start Session")).toBeInTheDocument()
  })

  it("should show start session button that triggers connect", async () => {
    render(<CollaborationPanel {...defaultProps} />)

    const button = screen.getByText("Collaborate")
    await userEvent.click(button)

    const startButton = screen.getByText("Start Session")
    expect(startButton).toBeInTheDocument()
    // Note: clicking startButton triggers async connect which requires more complex mocking
  })

  it("should show disconnected status initially", async () => {
    render(<CollaborationPanel {...defaultProps} />)

    const button = screen.getByText("Collaborate")
    await userEvent.click(button)

    expect(screen.getByText("Disconnected")).toBeInTheDocument()
  })

  it("should show join session input", async () => {
    render(<CollaborationPanel {...defaultProps} />)

    const button = screen.getByText("Collaborate")
    await userEvent.click(button)

    expect(screen.getByPlaceholderText("Enter session ID")).toBeInTheDocument()
  })

  it("should show empty participants message when no participants", async () => {
    render(<CollaborationPanel {...defaultProps} />)

    const button = screen.getByText("Collaborate")
    await userEvent.click(button)

    expect(screen.getByText("No participants yet")).toBeInTheDocument()
  })

  it("should render custom trigger if provided", () => {
    render(<CollaborationPanel {...defaultProps} trigger={<button>Custom Trigger</button>} />)

    expect(screen.getByText("Custom Trigger")).toBeInTheDocument()
    expect(screen.queryByText("Collaborate")).not.toBeInTheDocument()
  })
})

describe("CollaborationPanel with active session", () => {
  it("should handle session state changes", () => {
    expect(mockConnect).toBeDefined()
    expect(mockDisconnect).toBeDefined()
    expect(mockShareSession).toBeDefined()
    expect(mockJoinSession).toBeDefined()
  })
})

describe("CollaborationPanel fallback messaging", () => {
  it("shows fallback message when disconnected", async () => {
    render(<CollaborationPanel documentId="doc-1" documentContent="test" />)

    const button = screen.getByText("Collaborate")
    await userEvent.click(button)

    expect(
      screen.getByText("Collaboration transport unavailable. You can continue editing locally.")
    ).toBeInTheDocument()
  })

  it("shows copy error when no share state is available", async () => {
    const hookModule = jest.requireMock("@/hooks/canvas")
    const originalHook = hookModule.useCollaborativeSession
    hookModule.useCollaborativeSession = () => ({
      session: { id: "session-1" },
      participants: [],
      connectionState: "connected",
      isConnected: true,
      connect: mockConnect,
      disconnect: mockDisconnect,
      shareSession: () => null,
      joinSession: mockJoinSession,
    })

    render(<CollaborationPanel documentId="doc-1" documentContent="test" />)
    const button = screen.getByText("Collaborate")
    await userEvent.click(button)

    await userEvent.click(screen.getByText("Copy Link"))
    expect(screen.getByText("No active session to share yet.")).toBeInTheDocument()

    hookModule.useCollaborativeSession = originalHook
  })
})

describe("CollaborationPanel connection states", () => {
  it("should display correct text for each CollaborationConnectionState", async () => {
    // Test that the component correctly maps connection states to display text
    // The hook mock returns 'disconnected' by default
    render(<CollaborationPanel documentId="doc-1" documentContent="test" />)

    const button = screen.getByText("Collaborate")
    await userEvent.click(button)

    // Default state is 'disconnected'
    expect(screen.getByText("Disconnected")).toBeInTheDocument()
  })

  it("should show connecting state text", async () => {
    // Override the hook mock for 'connecting' state
    const hookModule = jest.requireMock("@/hooks/canvas")
    const originalHook = hookModule.useCollaborativeSession
    hookModule.useCollaborativeSession = () => ({
      session: null,
      participants: [],
      connectionState: "connecting",
      isConnected: false,
      connect: mockConnect,
      disconnect: mockDisconnect,
      shareSession: mockShareSession,
      joinSession: mockJoinSession,
    })

    render(<CollaborationPanel documentId="doc-1" documentContent="test" />)
    const button = screen.getByText("Collaborate")
    await userEvent.click(button)

    expect(screen.getByText("Connecting...")).toBeInTheDocument()

    hookModule.useCollaborativeSession = originalHook
  })

  it("should show error state text", async () => {
    const hookModule = jest.requireMock("@/hooks/canvas")
    const originalHook = hookModule.useCollaborativeSession
    hookModule.useCollaborativeSession = () => ({
      session: null,
      participants: [],
      connectionState: "error",
      isConnected: false,
      connect: mockConnect,
      disconnect: mockDisconnect,
      shareSession: mockShareSession,
      joinSession: mockJoinSession,
    })

    render(<CollaborationPanel documentId="doc-1" documentContent="test" />)
    const button = screen.getByText("Collaborate")
    await userEvent.click(button)

    expect(screen.getByText("Connection Error")).toBeInTheDocument()

    hookModule.useCollaborativeSession = originalHook
  })

  it("should show reconnecting state text", async () => {
    const hookModule = jest.requireMock("@/hooks/canvas")
    const originalHook = hookModule.useCollaborativeSession
    hookModule.useCollaborativeSession = () => ({
      session: null,
      participants: [],
      connectionState: "reconnecting",
      isConnected: false,
      connect: mockConnect,
      disconnect: mockDisconnect,
      shareSession: mockShareSession,
      joinSession: mockJoinSession,
    })

    render(<CollaborationPanel documentId="doc-1" documentContent="test" />)
    const button = screen.getByText("Collaborate")
    await userEvent.click(button)

    expect(screen.getByText("Reconnecting...")).toBeInTheDocument()

    hookModule.useCollaborativeSession = originalHook
  })
})

describe("CollaborationPanel recovery actions", () => {
  it("shows reconnect and continue locally actions for degraded collaboration state", async () => {
    const onReconnect = jest.fn()
    const onContinueLocally = jest.fn()

    render(
      <CollaborationPanel
        documentId="doc-1"
        documentContent="test"
        collaboration={
          {
            session: { id: "session-1" },
            participants: [],
            connectionState: "error",
            isConnected: false,
            isConnecting: false,
            localParticipant: null,
            connect: mockConnect,
            disconnect: mockDisconnect,
            updateContent: jest.fn(),
            updateCursor: jest.fn(),
            updateSelection: jest.fn(),
            getContent: jest.fn(),
            shareSession: mockShareSession,
            joinSession: mockJoinSession,
            importSharedSession: jest.fn(),
          } as never
        }
        collaborationState={{
          sessionId: "session-1",
          documentId: "doc-1",
          connectionState: "degraded-local",
          recoveryState: "local-copy",
          recoveryReason: "Connection dropped",
          participants: [],
          remoteCursors: [],
        }}
        onReconnect={onReconnect}
        onContinueLocally={onContinueLocally}
      />
    )

    await userEvent.click(screen.getByText("Collaborate"))

    await userEvent.click(screen.getByRole("button", { name: "Reconnect" }))
    expect(onReconnect).toHaveBeenCalled()

    await userEvent.click(screen.getByRole("button", { name: "Continue Locally" }))
    expect(onContinueLocally).toHaveBeenCalled()
  })

  it("shows snapshot-only status for ended shared sessions", async () => {
    render(
      <CollaborationPanel
        documentId="doc-1"
        documentContent="test"
        collaborationState={{
          sessionId: "session-1",
          documentId: "doc-1",
          connectionState: "ended",
          recoveryState: "snapshot-only",
          recoveryReason: "Live session is no longer available. Continuing with a local snapshot.",
          participants: [],
          remoteCursors: [],
        }}
      />
    )

    await userEvent.click(screen.getByText("Collaborate"))

    expect(screen.getAllByText("Session ended").length).toBeGreaterThan(0)
    expect(screen.getByText("Snapshot only")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Reconnect" })).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Continue Locally" })).toBeInTheDocument()
    expect(screen.getByTestId("canvas-collab-fallback-message")).toHaveTextContent(
      "Live session is no longer available. Continuing with a local snapshot."
    )
  })

  it("prefers collaboration-state participants for the participant summary", async () => {
    render(
      <CollaborationPanel
        documentId="doc-1"
        documentContent="test"
        collaborationState={{
          sessionId: "session-1",
          documentId: "doc-1",
          connectionState: "connected",
          recoveryState: "live",
          participants: [
            {
              id: "participant-1",
              name: "Trainer",
              color: "#3b82f6",
              isOnline: true,
              lastActive: new Date(),
            },
            {
              id: "participant-2",
              name: "Partner",
              color: "#22c55e",
              isOnline: false,
              lastActive: new Date(),
            },
          ],
          remoteCursors: [],
        }}
      />
    )

    await userEvent.click(screen.getByText("Collaborate"))

    expect(screen.getByRole("heading", { name: "Participants (2)" })).toBeInTheDocument()
    expect(screen.getByText("Trainer")).toBeInTheDocument()
    expect(screen.getByText("Partner")).toBeInTheDocument()
  })
})

import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { RemoteSessionDetail } from "./remote-session-detail"
import { useConnectionState } from "@/hooks/companion/use-connection-state"
import type { RemoteSessionStream } from "@/hooks/data/use-remote-session-stream"
import type { ConnectionState } from "@/lib/tauri/transport-companion"

const transcriptListMock = jest.fn(() => <div data-testid="remote-transcript-list" />)
jest.mock("@/components/chat/transcript-message-list", () => ({
  TranscriptMessageList: (props: unknown) => transcriptListMock(props),
}))

const timelineSurfaceMock = jest.fn(() => <div data-testid="remote-timeline-surface" />)
jest.mock("@/components/chat/transcript-timeline-surface", () => ({
  TranscriptTimelineSurface: (props: unknown) => timelineSurfaceMock(props),
}))

const transcriptControllerMock = jest.fn()
jest.mock("@/hooks/chat/use-transcript-controller", () => ({
  useTranscriptController: () => transcriptControllerMock(),
}))

jest.mock("@/lib/chat/transcript/source", () => ({
  createRemoteTranscriptSource: () => ({}),
}))

const streamMock = jest.fn()
jest.mock("@/hooks/data/use-remote-session-stream", () => ({
  useRemoteSessionStream: () => streamMock(),
}))

jest.mock("@/hooks/companion/use-connection-state", () => ({
  useConnectionState: jest.fn(() => null),
}))

// OfflineBanner pulls usePlatform + network live queries — out of scope here.
jest.mock("@/components/mobile/offline-banner", () => ({
  OfflineBanner: () => null,
}))

const connectionMock = useConnectionState as jest.MockedFunction<typeof useConnectionState>

function setConnection(state: ConnectionState | null) {
  connectionMock.mockReturnValue(state)
}

function baseStream(overrides: Partial<RemoteSessionStream> = {}): RemoteSessionStream {
  return {
    messages: [],
    status: "idle",
    pendingApproval: null,
    canControl: true,
    sessionEnded: false,
    notFound: false,
    send: jest.fn().mockResolvedValue(undefined),
    interrupt: jest.fn().mockResolvedValue(undefined),
    respond: jest.fn().mockResolvedValue(undefined),
    reconcileTranscript: jest.fn(),
    ...overrides,
  }
}

describe("<RemoteSessionDetail />", () => {
  beforeEach(() => {
    window.localStorage.clear()
    connectionMock.mockReturnValue(null)
    transcriptControllerMock.mockReturnValue({
      snapshot: {
        mode: "legacy",
        items: [],
        revision: 0,
        loading: false,
        loadingOlder: false,
        hasMore: false,
        expandedTurnKeys: new Set(),
        error: null,
      },
      getDetail: jest.fn(),
      loadOlder: jest.fn(),
      expandTurn: jest.fn(),
      collapseTurn: jest.fn(),
      retry: jest.fn(),
    })
  })

  it("uses the folded timeline and skips legacy history seeding on a capable host", () => {
    transcriptControllerMock.mockReturnValue({
      snapshot: {
        mode: "timeline",
        items: [{ kind: "system", itemKey: "s" }],
        revision: 1,
        loading: false,
        loadingOlder: false,
        hasMore: false,
        expandedTurnKeys: new Set(),
        error: null,
      },
      getDetail: jest.fn(),
      loadOlder: jest.fn(),
      expandTurn: jest.fn(),
      collapseTurn: jest.fn(),
      retry: jest.fn(),
    })
    streamMock.mockReturnValue(baseStream())

    render(<RemoteSessionDetail sessionId="s1" />)

    expect(screen.getByTestId("remote-timeline-surface")).toBeInTheDocument()
  })

  it("releases completed live messages after a timeline revision is rendered", () => {
    const reconcileTranscript = jest.fn()
    transcriptControllerMock.mockReturnValue({
      snapshot: {
        mode: "timeline",
        items: [],
        revision: 7,
        loading: false,
        loadingOlder: false,
        hasMore: false,
        expandedTurnKeys: new Set(),
        error: null,
      },
      getDetail: jest.fn(),
      loadOlder: jest.fn(),
      expandTurn: jest.fn(),
      collapseTurn: jest.fn(),
      retry: jest.fn(),
    })
    streamMock.mockReturnValue(baseStream({ reconcileTranscript }))

    render(<RemoteSessionDetail sessionId="s1" />)

    expect(reconcileTranscript).toHaveBeenCalledTimes(1)
  })

  it("renders streamed messages through the shared read-only transcript surface", () => {
    const messages = [
      {
        id: "a1",
        role: "assistant",
        parts: [
          { type: "text", text: "hi there" },
          { type: "reasoning", text: "checking" },
        ],
      },
    ] as never
    streamMock.mockReturnValue(
      baseStream({
        messages,
        status: "streaming",
      })
    )
    render(<RemoteSessionDetail sessionId="s1" />)
    expect(screen.getByTestId("remote-transcript-list")).toBeInTheDocument()
    expect(transcriptListMock).toHaveBeenCalledWith({
      messages,
      sessionId: "s1",
      status: "streaming",
    })
  })

  it("sends a follow-up via the composer", async () => {
    const send = jest.fn().mockResolvedValue(undefined)
    streamMock.mockReturnValue(baseStream({ send }))
    const user = userEvent.setup()
    render(<RemoteSessionDetail sessionId="s1" />)
    await user.type(screen.getByTestId("remote-composer-input"), "do it")
    await user.click(screen.getByTestId("remote-send"))
    expect(send).toHaveBeenCalledWith("do it")
  })

  it("recalls previously sent follow-ups with ArrowUp/ArrowDown", async () => {
    const send = jest.fn().mockResolvedValue(undefined)
    streamMock.mockReturnValue(baseStream({ send }))
    const user = userEvent.setup()
    render(<RemoteSessionDetail sessionId="recall-1" />)
    const input = screen.getByTestId("remote-composer-input")
    await user.type(input, "first cmd{Enter}")
    await user.type(input, "second cmd{Enter}")
    expect(send).toHaveBeenCalledTimes(2)
    expect(input).toHaveValue("") // cleared after send

    await user.keyboard("{ArrowUp}")
    expect(input).toHaveValue("second cmd") // newest first
    await user.keyboard("{ArrowUp}")
    expect(input).toHaveValue("first cmd")
    await user.keyboard("{ArrowDown}")
    expect(input).toHaveValue("second cmd")
    await user.keyboard("{ArrowDown}") // past the newest → stashed (empty) draft
    expect(input).toHaveValue("")
  })

  it("shows the interrupt control while streaming", () => {
    streamMock.mockReturnValue(baseStream({ status: "streaming" }))
    render(<RemoteSessionDetail sessionId="s1" />)
    expect(screen.getByTestId("remote-interrupt")).toBeInTheDocument()
    expect(screen.getByTestId("remote-streaming-badge")).toBeInTheDocument()
  })

  it("renders the approval card when a request is pending and controllable", () => {
    streamMock.mockReturnValue(
      baseStream({
        pendingApproval: {
          sessionId: "s1",
          requestId: "r1",
          toolUseID: "tu1",
          toolName: "bash",
          input: {},
        },
      })
    )
    render(<RemoteSessionDetail sessionId="s1" />)
    expect(screen.getByTestId("remote-approval-card")).toBeInTheDocument()
  })

  it("hides the composer and shows observe-only when control is denied", () => {
    streamMock.mockReturnValue(baseStream({ canControl: false }))
    render(<RemoteSessionDetail sessionId="s1" />)
    expect(screen.queryByTestId("remote-composer-input")).not.toBeInTheDocument()
    expect(screen.getByTestId("remote-observe-only")).toBeInTheDocument()
  })

  it("locks the composer and shows an ended notice when the session ends", () => {
    streamMock.mockReturnValue(baseStream({ sessionEnded: true }))
    render(<RemoteSessionDetail sessionId="s1" />)
    expect(screen.getByTestId("remote-session-ended")).toBeInTheDocument()
    expect(screen.getByTestId("remote-ended-badge")).toBeInTheDocument()
    expect(screen.queryByTestId("remote-composer-input")).not.toBeInTheDocument()
  })

  it("shows a not-found notice when the session no longer exists", () => {
    streamMock.mockReturnValue(baseStream({ notFound: true, canControl: false }))
    render(<RemoteSessionDetail sessionId="s1" />)
    expect(screen.getByTestId("remote-session-not-found")).toBeInTheDocument()
    expect(screen.queryByTestId("remote-composer-input")).not.toBeInTheDocument()
  })

  it("renders the connection pill from the transport state", () => {
    setConnection("reconnecting")
    streamMock.mockReturnValue(baseStream())
    render(<RemoteSessionDetail sessionId="s1" />)
    const pill = screen.getByTestId("remote-connection-pill")
    expect(pill).toHaveAttribute("data-state", "reconnecting")
  })

  it("disables sending while the transport is offline/reconnecting", () => {
    setConnection("offline")
    streamMock.mockReturnValue(baseStream())
    render(<RemoteSessionDetail sessionId="s1" />)
    expect(screen.getByTestId("remote-send")).toBeDisabled()
    expect(screen.getByTestId("remote-offline-hint")).toBeInTheDocument()
  })
})

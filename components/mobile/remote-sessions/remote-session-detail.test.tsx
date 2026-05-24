import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { RemoteSessionDetail } from "./remote-session-detail"
import type { RemoteSessionStream } from "@/hooks/data/use-remote-session-stream"

const streamMock = jest.fn()
jest.mock("@/hooks/data/use-remote-session-stream", () => ({
  useRemoteSessionStream: () => streamMock(),
}))

function baseStream(overrides: Partial<RemoteSessionStream> = {}): RemoteSessionStream {
  return {
    messages: [],
    status: "idle",
    pendingApproval: null,
    canControl: true,
    send: jest.fn().mockResolvedValue(undefined),
    interrupt: jest.fn().mockResolvedValue(undefined),
    respond: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  }
}

describe("<RemoteSessionDetail />", () => {
  it("renders streamed messages", () => {
    streamMock.mockReturnValue(
      baseStream({
        messages: [{ id: "a1", role: "assistant", parts: [{ type: "text", text: "hi there" }] }] as never,
      })
    )
    render(<RemoteSessionDetail sessionId="s1" />)
    expect(screen.getByText("hi there")).toBeInTheDocument()
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
})

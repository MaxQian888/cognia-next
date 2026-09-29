/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"
import type { ToolUIPart } from "ai"
import type { ChatSession } from "@cognia/agent-config-types"

let liveThread: ChatSession | null | undefined
jest.mock("@/hooks/data", () => ({ useClientLiveQuery: () => liveThread }))
jest.mock("@/lib/db/sessions", () => ({ getSession: jest.fn() }))
jest.mock("@/components/project-coordinator/thread-row", () => ({
  ProjectThreadRow: ({ row }: { row: { thread: ChatSession; state: string } }) => (
    <span data-testid="row">{`${row.thread.title}:${row.state}`}</span>
  ),
}))

import { ProjectThreadCard } from "./project-thread-card"

const part = (output: unknown) =>
  ({
    type: "tool-spawn_thread",
    state: "output-available",
    output: JSON.stringify(output),
  }) as unknown as ToolUIPart

describe("ProjectThreadCard", () => {
  it("renders the live thread row for a thread tool result", () => {
    liveThread = {
      id: "t1",
      title: "Fix login",
      createdAt: 1,
      updatedAt: 1,
      attachedChild: { status: "staged" },
    } as ChatSession
    render(<ProjectThreadCard part={part({ ok: true, threadId: "t1" })} />)
    expect(screen.getByTestId("row").textContent).toBe("Fix login:staged")
  })

  it("says when the thread is gone and renders nothing for a failed call", () => {
    liveThread = null
    const { unmount } = render(<ProjectThreadCard part={part({ ok: true, threadId: "t1" })} />)
    expect(screen.getByTestId("mcp-project-thread-missing")).toBeInTheDocument()
    unmount()
    const { container } = render(<ProjectThreadCard part={part({ ok: false, error: "x" })} />)
    expect(container).toBeEmptyDOMElement()
  })
})

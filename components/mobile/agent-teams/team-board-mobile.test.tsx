/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { TeamBoardMobile } from "./team-board-mobile"
import { transport } from "@/lib/tauri/transport-instance"
import { toast } from "sonner"
import type { AgentTeamBoardRow } from "@/lib/db/agent-team-board"

let mockRows: AgentTeamBoardRow[] = []
jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: () => mockRows,
}))

jest.mock("@/lib/db/schema", () => ({ getDb: jest.fn() }))

jest.mock("@/lib/tauri/transport-instance", () => ({
  transport: { call: jest.fn(), subscribe: jest.fn(() => () => {}) },
}))

jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn(), info: jest.fn() } }))

const callMock = transport.call as jest.Mock

const taskRow = (
  id: string,
  overrides: Partial<Extract<AgentTeamBoardRow, { kind: "task" }>> = {}
): AgentTeamBoardRow => ({
  id,
  kind: "task",
  teamId: "t1",
  title: `Task ${id}`,
  description: "",
  status: "pending",
  priority: "normal",
  dependencies: [],
  tags: [],
  order: 0,
  commentCount: 0,
  comments: [],
  attachmentsCount: 0,
  createdAt: 100,
  updatedAt: 100,
  ...overrides,
})

const metaRow = (status = "paused"): AgentTeamBoardRow => ({
  id: "team:t1",
  kind: "team",
  teamId: "t1",
  name: "Alpha",
  status: status as never,
  maxConcurrentTeammates: 2,
  teammates: [{ id: "w1", name: "Worker One", role: "teammate", status: "idle" }],
  knowledgeTwinIds: [],
  updatedAt: 100,
})

beforeEach(() => {
  mockRows = []
  jest.clearAllMocks()
})

describe("<TeamBoardMobile />", () => {
  it("renders the empty hint when nothing has synced", () => {
    render(<TeamBoardMobile teamId="t1" />)
    expect(screen.getByTestId("mobile-board-empty")).toBeInTheDocument()
  })

  it("renders columns from the synced mirror with run controls for the status", () => {
    mockRows = [metaRow("paused"), taskRow("a"), taskRow("b", { status: "failed" })]
    render(<TeamBoardMobile teamId="t1" />)
    expect(screen.getByTestId("mobile-board-columns")).toBeInTheDocument()
    expect(screen.getByTestId("mobile-board-card-a")).toBeInTheDocument()
    expect(screen.getByTestId("mobile-board-resume")).toBeInTheDocument()
    expect(screen.getByTestId("mobile-board-stop")).toBeInTheDocument()
    expect(screen.queryByTestId("mobile-board-pause")).not.toBeInTheDocument()
  })

  it("opens the detail sheet with guard-derived move targets and sends the RPC", async () => {
    const user = userEvent.setup()
    callMock.mockResolvedValue({ ok: true })
    mockRows = [metaRow("idle"), taskRow("f", { status: "failed" })]
    render(<TeamBoardMobile teamId="t1" />)

    await user.click(screen.getByTestId("mobile-board-card-f"))
    // failed at rest → only pending is a legal target.
    expect(await screen.findByTestId("mobile-board-move-pending")).toBeInTheDocument()
    expect(screen.queryByTestId("mobile-board-move-completed")).not.toBeInTheDocument()

    await user.click(screen.getByTestId("mobile-board-move-pending"))
    expect(callMock).toHaveBeenCalledWith("team_task_move", {
      teamId: "t1",
      taskId: "f",
      to: "pending",
    })
    expect(toast.success).toHaveBeenCalled()
  })

  it("surfaces guard denials from the desktop as error toasts", async () => {
    const user = userEvent.setup()
    callMock.mockResolvedValue({ ok: false, reason: "runtime-owned" })
    mockRows = [metaRow("idle"), taskRow("f", { status: "failed" })]
    render(<TeamBoardMobile teamId="t1" />)
    await user.click(screen.getByTestId("mobile-board-card-f"))
    await user.click(await screen.findByTestId("mobile-board-move-pending"))
    expect(toast.error).toHaveBeenCalled()
  })

  it("reports unreachable desktops without crashing the snapshot view", async () => {
    const user = userEvent.setup()
    callMock.mockRejectedValue(new Error("transport down"))
    mockRows = [metaRow("paused"), taskRow("a")]
    render(<TeamBoardMobile teamId="t1" />)
    await user.click(screen.getByTestId("mobile-board-resume"))
    expect(toast.error).toHaveBeenCalled()
    expect(screen.getByTestId("mobile-board-columns")).toBeInTheDocument()
  })

  it("sends comments and clears the composer on success", async () => {
    const user = userEvent.setup()
    callMock.mockResolvedValue({ ok: true, commentId: "c1" })
    mockRows = [metaRow("idle"), taskRow("a", { commentCount: 1 })]
    render(<TeamBoardMobile teamId="t1" />)
    await user.click(screen.getByTestId("mobile-board-card-a"))
    const input = await screen.findByTestId("mobile-board-comment-input")
    await user.type(input, "hello from phone")
    await user.click(screen.getByTestId("mobile-board-comment-send"))
    expect(callMock).toHaveBeenCalledWith("team_task_comment", {
      teamId: "t1",
      taskId: "a",
      text: "hello from phone",
    })
    expect((input as HTMLInputElement).value).toBe("")
  })
})

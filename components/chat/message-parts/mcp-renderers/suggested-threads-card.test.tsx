/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { ToolUIPart } from "ai"

const toastInfo = jest.fn()
jest.mock("sonner", () => ({
  toast: { info: (...a: unknown[]) => toastInfo(...a), error: jest.fn() },
}))
let coordinator: unknown = { id: "coord", projectId: "p1", projectRole: "coordinator" }
jest.mock("@/hooks/data", () => ({ useClientLiveQuery: () => coordinator }))
jest.mock("@/lib/db/sessions", () => ({ getSession: jest.fn() }))
jest.mock("@/lib/project-coordinator/user-actions", () => ({
  startProposedThread: jest.fn(async () => ({
    kind: "created",
    thread: { id: "t" },
    start: { kind: "started" },
  })),
}))

import { startProposedThread } from "@/lib/project-coordinator/user-actions"
import { SuggestedThreadsCard } from "./suggested-threads-card"

const proposal = (title: string, extra = {}) => ({
  title,
  tldr: `${title} tldr`,
  situation: "s",
  codeLocations: [],
  solution: "x",
  caveats: [],
  mode: "aside",
  ...extra,
})
const part = {
  type: "tool-propose_threads",
  state: "output-available",
  output: JSON.stringify({ ok: true, proposals: [proposal("A", { rootId: "r2" }), proposal("B")] }),
} as unknown as ToolUIPart

beforeEach(() => {
  jest.clearAllMocks()
  coordinator = { id: "coord", projectId: "p1", projectRole: "coordinator" }
})

describe("SuggestedThreadsCard", () => {
  it("starts one proposal as the user's thread", async () => {
    render(<SuggestedThreadsCard part={part} sessionId="coord" />)
    fireEvent.click(screen.getByTestId("suggested-thread-start-0"))
    await waitFor(() =>
      expect(startProposedThread).toHaveBeenCalledWith({
        projectId: "p1",
        coordinatorSessionId: "coord",
        brief: expect.objectContaining({ title: "A" }),
        rootId: "r2",
      })
    )
    await waitFor(() =>
      expect(screen.getByTestId("suggested-thread-0").textContent).toContain("Started")
    )
    expect(screen.queryByTestId("suggested-threads-start-all")).toBeNull()
  })

  it("starts all, stopping at a hard refusal", async () => {
    ;(startProposedThread as jest.Mock).mockResolvedValueOnce({
      kind: "refused",
      reason: "daily-cap",
    })
    render(<SuggestedThreadsCard part={part} sessionId="coord" />)
    fireEvent.click(screen.getByTestId("suggested-threads-start-all"))
    await waitFor(() =>
      expect(toastInfo).toHaveBeenCalledWith("The project reached its daily thread limit.")
    )
    expect(startProposedThread).toHaveBeenCalledTimes(1)
  })

  it("disables starting outside a coordinator conversation", () => {
    coordinator = { id: "x", projectId: "p1" }
    render(<SuggestedThreadsCard part={part} sessionId="x" />)
    expect(screen.getByTestId("suggested-thread-start-0")).toBeDisabled()
  })
})

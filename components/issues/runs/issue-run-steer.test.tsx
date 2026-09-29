/** @jest-environment jsdom */

jest.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))
const mockSessionIds = jest.fn(async (_run: unknown): Promise<string[]> => ["s1"])
const mockSteer = jest.fn(async (_run: unknown, _text: string) => true)
jest.mock("@/lib/issues/run/registry", () => ({
  issueRunSessionIds: (run: unknown) => mockSessionIds(run),
  steerIssueRun: (run: unknown, text: string) => mockSteer(run, text),
}))
jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn() } }))

import { act, fireEvent, render, screen } from "@testing-library/react"
import { toast } from "sonner"
import type { IssueRun } from "@/types/issues"
import { IssueRunSteer } from "./issue-run-steer"

function run(over: Partial<IssueRun> = {}): IssueRun {
  return {
    id: "r1",
    issueId: "i1",
    projectId: "w1",
    adapterId: "agent-task",
    status: "running",
    startedAt: 1,
    ...over,
  } as IssueRun
}

beforeEach(() => {
  mockSessionIds.mockClear()
  mockSessionIds.mockResolvedValue(["s1"])
  mockSteer.mockClear()
  mockSteer.mockResolvedValue(true)
  ;(toast.success as jest.Mock).mockClear()
  ;(toast.error as jest.Mock).mockClear()
})

describe("IssueRunSteer", () => {
  it("sends the text through the one steer path and clears the draft", async () => {
    const active = run()
    render(<IssueRunSteer run={active} />)
    const input = await screen.findByTestId("issue-run-steer-input")
    expect(screen.getByTestId("issue-run-steer-send")).toBeDisabled()
    fireEvent.change(input, { target: { value: "  Use the staging database  " } })
    await act(async () => {
      fireEvent.click(screen.getByTestId("issue-run-steer-send"))
    })
    expect(mockSteer).toHaveBeenCalledWith(active, "Use the staging database")
    expect(toast.success).toHaveBeenCalledWith("run.steerSent")
    expect(input).toHaveValue("")
  })

  it("keeps the draft and says so when the run refuses the text", async () => {
    mockSteer.mockResolvedValueOnce(false)
    render(<IssueRunSteer run={run()} />)
    const input = await screen.findByTestId("issue-run-steer-input")
    fireEvent.change(input, { target: { value: "stop" } })
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter", metaKey: true })
    })
    expect(toast.error).toHaveBeenCalledWith("run.steerRefused")
    expect(input).toHaveValue("stop")
  })

  it("says the engine takes no input instead of offering a send it would refuse", async () => {
    mockSessionIds.mockResolvedValueOnce([])
    render(<IssueRunSteer run={run({ adapterId: "team" })} />)
    expect(await screen.findByTestId("issue-run-steer-unavailable")).toHaveTextContent(
      "run.steerUnavailable"
    )
    expect(screen.queryByTestId("issue-run-steer")).not.toBeInTheDocument()
  })

  it("treats a failed session lookup as unsteerable", async () => {
    mockSessionIds.mockRejectedValueOnce(new Error("gone"))
    render(<IssueRunSteer run={run()} />)
    expect(await screen.findByTestId("issue-run-steer-unavailable")).toBeInTheDocument()
  })

  it("asks again for a different run", async () => {
    const { rerender } = render(<IssueRunSteer run={run()} />)
    await screen.findByTestId("issue-run-steer")
    mockSessionIds.mockResolvedValueOnce([])
    rerender(<IssueRunSteer run={run({ id: "r2" })} />)
    expect(await screen.findByTestId("issue-run-steer-unavailable")).toBeInTheDocument()
    expect(mockSessionIds).toHaveBeenCalledTimes(2)
  })
})

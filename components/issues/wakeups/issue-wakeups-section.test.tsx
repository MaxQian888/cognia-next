/**
 * @jest-environment jsdom
 */

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, string | number>) =>
    vars ? `${key}:${Object.values(vars).join(",")}` : key,
}))

const mockToast = { success: jest.fn(), error: jest.fn() }
jest.mock("sonner", () => ({
  toast: {
    success: (...args: unknown[]) => mockToast.success(...args),
    error: (...args: unknown[]) => mockToast.error(...args),
  },
}))

let mockTasks: ScheduledTask[] = []
let mockContainer: { childrenDoneInstruction?: string } | null = null
jest.mock("@/hooks/data", () => ({
  // The section reads two things live: its rules (initial []) and the issue's
  // project (initial null), told apart by what each starts from.
  useClientLiveQuery: (_query: unknown, _deps: unknown, initial: unknown) =>
    initial === null ? mockContainer : mockTasks,
}))
jest.mock("@/lib/db/issues", () => ({ getIssue: jest.fn() }))
jest.mock("@/lib/db/issue-projects", () => ({ getIssueProject: jest.fn() }))
jest.mock("@/components/ui/select")
jest.mock("@/components/ui/switch")
jest.mock("@/components/ui/dialog")

const mockSetEnabled = jest.fn()
const mockDelete = jest.fn()
const mockSetInstruction = jest.fn()
jest.mock("@/lib/issues/wakeups/service", () => {
  class IssueWakeupWriteError extends Error {
    constructor(
      readonly reason: string,
      message: string
    ) {
      super(message)
    }
  }
  return {
    IssueWakeupWriteError,
    listIssueWakeups: jest.fn(),
    createIssueWakeup: jest.fn(),
    setIssueWakeupEnabled: (...args: unknown[]) => mockSetEnabled(...args),
    deleteIssueWakeup: (...args: unknown[]) => mockDelete(...args),
    setChildrenDoneInstruction: (...args: unknown[]) => mockSetInstruction(...args),
  }
})

import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import type { ScheduledTask } from "@/types/scheduler"
import { IssueWakeupsSection } from "./issue-wakeups-section"

function wakeup(
  over: Partial<ScheduledTask> = {},
  payload: Record<string, unknown> = {}
): ScheduledTask {
  return {
    id: "wk1",
    name: "w",
    type: "issue-wakeup",
    trigger: { type: "event", eventType: "issue:activity", eventSource: "issue:i1" },
    payload: {
      issueId: "i1",
      instruction: "Answer new comments",
      match: { kinds: ["commented"], actorKinds: ["human"] },
      ...payload,
    },
    config: { timeout: 1, maxRetries: 0, retryDelay: 0, runMissedOnStartup: false, maxRuns: 20 },
    notification: { onStart: false, onComplete: false, onError: true },
    status: "active",
    runCount: 3,
    successCount: 3,
    failureCount: 0,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...over,
  }
}

beforeEach(() => {
  mockTasks = []
  mockContainer = null
  jest.clearAllMocks()
})

it("says there are none, and offers to add one", () => {
  render(<IssueWakeupsSection issueId="i1" identifier="MERC-1" />)
  expect(screen.getByTestId("issue-wakeup-empty")).toHaveTextContent("empty")
  expect(screen.getByTestId("issue-wakeup-add")).toBeEnabled()
})

it("describes each rule's trigger, state, instruction and budget", () => {
  mockTasks = [wakeup()]
  render(<IssueWakeupsSection issueId="i1" identifier="MERC-1" />)
  const row = screen.getByTestId("issue-wakeup-wk1")
  expect(row).toHaveTextContent("trigger.byPeople:trigger.event:commented")
  expect(row).toHaveTextContent("Answer new comments")
  expect(row).toHaveTextContent("fires:3,20")
  expect(within(row).getByTestId("issue-wakeup-state")).toHaveTextContent("state.active")
})

it("names why a rule stopped itself and how many inputs it holds", () => {
  mockTasks = [
    wakeup(
      { status: "paused", lastTerminalReason: "wakeup-paused-rate" },
      { deferred: [{ kind: "commented", subjectId: "i1", ts: 0, summary: "s", chain: [] }] }
    ),
  ]
  render(<IssueWakeupsSection issueId="i1" identifier="MERC-1" />)
  expect(screen.getByTestId("issue-wakeup-state")).toHaveTextContent("pauseReason.rate")
  expect(screen.getByTestId("issue-wakeup-held")).toHaveTextContent("held:1")
})

it("labels the platform rule and a spent budget", () => {
  mockTasks = [
    wakeup(
      { status: "expired", lastTerminalReason: "max-runs-reached" },
      { system: "children-done", condition: { kind: "children-done" } }
    ),
  ]
  render(<IssueWakeupsSection issueId="i1" identifier="MERC-1" />)
  const row = screen.getByTestId("issue-wakeup-wk1")
  expect(row).toHaveTextContent("trigger.childrenDone")
  expect(row).toHaveTextContent("system")
  expect(row).toHaveTextContent("state.budgetSpent")
})

it("names the outcome a pr-checks rule waits for", () => {
  mockTasks = [
    wakeup(
      {},
      {
        match: { kinds: ["pr_checks_changed"] },
        condition: { kind: "pr-checks", result: "failing" },
      }
    ),
  ]
  render(<IssueWakeupsSection issueId="i1" identifier="MERC-1" />)
  expect(screen.getByTestId("issue-wakeup-wk1")).toHaveTextContent("trigger.prChecksResult:failing")
})

it("pauses, resumes and deletes as the user", async () => {
  mockSetEnabled.mockResolvedValue(undefined)
  mockDelete.mockResolvedValue(undefined)
  mockTasks = [wakeup()]
  const { rerender } = render(<IssueWakeupsSection issueId="i1" identifier="MERC-1" />)
  fireEvent.click(screen.getByTestId("issue-wakeup-pause"))
  await waitFor(() => expect(mockSetEnabled).toHaveBeenCalledWith("wk1", false, { source: "user" }))
  await waitFor(() => expect(mockToast.success).toHaveBeenCalledWith("pausedToast"))

  mockTasks = [wakeup({ status: "paused" })]
  rerender(<IssueWakeupsSection issueId="i1" identifier="MERC-1" />)
  fireEvent.click(screen.getByTestId("issue-wakeup-resume"))
  await waitFor(() => expect(mockSetEnabled).toHaveBeenCalledWith("wk1", true, { source: "user" }))

  fireEvent.click(screen.getByTestId("issue-wakeup-delete"))
  await waitFor(() => expect(mockDelete).toHaveBeenCalledWith("wk1", { source: "user" }))
})

it("reports a refused write as a toast", async () => {
  const { IssueWakeupWriteError } = jest.requireMock("@/lib/issues/wakeups/service")
  mockSetEnabled.mockRejectedValue(new IssueWakeupWriteError("issue-finished", "raw"))
  mockTasks = [wakeup({ status: "paused" })]
  render(<IssueWakeupsSection issueId="i1" identifier="MERC-1" />)
  fireEvent.click(screen.getByTestId("issue-wakeup-resume"))
  await waitFor(() => expect(mockToast.error).toHaveBeenCalledWith("error.issue-finished"))
})

it("on a finished issue, lists rules but lets none be added or resumed", () => {
  mockTasks = [wakeup({ status: "paused", lastTerminalReason: "wakeup-paused-issue-closed" })]
  render(<IssueWakeupsSection issueId="i1" identifier="MERC-1" finished />)
  expect(screen.getByTestId("issue-wakeup-add")).toBeDisabled()
  expect(screen.getByTestId("issue-wakeup-resume")).toBeDisabled()
  expect(screen.getByText("finishedHint")).toBeInTheDocument()
})

it("shows an active rule's deadline and whether it wakes at it", () => {
  mockTasks = [wakeup({ endAt: new Date("2030-01-01T09:00:00Z") }, { onTimeout: "wake" })]
  render(<IssueWakeupsSection issueId="i1" identifier="MERC-1" />)
  const expires = screen.getByTestId("issue-wakeup-expires")
  expect(expires.textContent).toMatch(/^expires:/)
  expect(expires).toHaveTextContent("wakesOnTimeout")
})

describe("the platform rule's instruction", () => {
  const platform = () =>
    wakeup(
      { id: "sys" },
      {
        system: "children-done",
        condition: { kind: "children-done" },
        instruction: "Built-in text.",
      }
    )

  it("shows the project's default as the fallback, and saves this issue's own words", async () => {
    mockContainer = { childrenDoneInstruction: "Project default." }
    mockTasks = [platform()]
    mockSetInstruction.mockResolvedValue(undefined)
    render(<IssueWakeupsSection issueId="i1" identifier="MERC-1" />)
    const box = screen.getByTestId("issue-wakeup-system-instruction")
    expect(box).toHaveTextContent("Project default.")
    fireEvent.click(box)
    const input = screen.getByTestId("issue-wakeup-system-instruction-input")
    fireEvent.change(input, { target: { value: "Tag the release." } })
    fireEvent.blur(input)
    await waitFor(() =>
      expect(mockSetInstruction).toHaveBeenCalledWith("i1", "Tag the release.", {
        source: "user",
      })
    )
    expect(mockToast.success).toHaveBeenCalledWith("instructionSavedToast")
  })

  it("clears the override with null when the box is emptied", async () => {
    mockTasks = [wakeup({ id: "sys" }, { ...platform().payload, instructionOverride: "Mine." })]
    mockSetInstruction.mockResolvedValue(undefined)
    render(<IssueWakeupsSection issueId="i1" identifier="MERC-1" />)
    const box = screen.getByTestId("issue-wakeup-system-instruction")
    expect(box).toHaveTextContent("Mine.")
    fireEvent.click(box)
    const input = screen.getByTestId("issue-wakeup-system-instruction-input")
    fireEvent.change(input, { target: { value: "  " } })
    fireEvent.blur(input)
    await waitFor(() =>
      expect(mockSetInstruction).toHaveBeenCalledWith("i1", null, { source: "user" })
    )
  })

  it("leaves an author's rule showing its own instruction, not an editor", () => {
    mockTasks = [wakeup()]
    render(<IssueWakeupsSection issueId="i1" identifier="MERC-1" />)
    expect(screen.queryByTestId("issue-wakeup-system-instruction")).not.toBeInTheDocument()
    expect(screen.getByTestId("issue-wakeup-wk1")).toHaveTextContent("Answer new comments")
  })
})

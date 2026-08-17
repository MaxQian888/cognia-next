/**
 * @jest-environment jsdom
 */

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${Object.values(values).join(",")}` : key,
}))

const mockListOptions = jest.fn()
const mockStart = jest.fn()
jest.mock("@/lib/issues/run/registry", () => {
  class IssueRunRefusedError extends Error {
    reason: string
    constructor(reason: string) {
      super(reason)
      this.reason = reason
    }
  }
  return {
    IssueRunRefusedError,
    listIssueRunOptions: (...a: unknown[]) => mockListOptions(...a),
    startIssueRun: (...a: unknown[]) => mockStart(...a),
  }
})
const mockToastSuccess = jest.fn()
jest.mock("sonner", () => ({ toast: { success: (...a: unknown[]) => mockToastSuccess(...a) } }))

import userEvent from "@testing-library/user-event"
import { render, screen, waitFor } from "@testing-library/react"
import { IssueRunRefusedError } from "@/lib/issues/run/registry"
import { RunIssueDialog } from "./run-issue-dialog"

const adapters = {
  agentTask: { id: "agent-task", kind: "agent-task" },
  team: { id: "agent-team", kind: "agent-team" },
  loop: { id: "github-loop", kind: "github-loop" },
}

function renderDialog(over: Partial<React.ComponentProps<typeof RunIssueDialog>> = {}) {
  const props: React.ComponentProps<typeof RunIssueDialog> = {
    open: true,
    onOpenChange: jest.fn(),
    issueId: "iss-1",
    identifier: "MERC-1",
    onStarted: jest.fn(),
    ...over,
  }
  return { ...render(<RunIssueDialog {...props} />), props }
}

beforeEach(() => {
  jest.clearAllMocks()
  mockListOptions.mockResolvedValue([
    { adapter: adapters.agentTask, verdict: { ok: false, reason: "assignee-kind-mismatch" } },
    { adapter: adapters.team, verdict: { ok: true } },
    { adapter: adapters.loop, verdict: { ok: true } },
  ])
  mockStart.mockResolvedValue({ id: "run-1", adapterId: "agent-team" })
})

describe("RunIssueDialog", () => {
  it("lists every engine, greys out refusals with their reason, preselects the first runnable", async () => {
    renderDialog()
    expect(screen.getByTestId("run-issue-loading")).toBeInTheDocument()
    const refused = await screen.findByTestId("run-issue-adapter-agent-task")
    expect(refused).toBeDisabled()
    expect(refused).toHaveTextContent("run.refusal.assignee-kind-mismatch")
    const team = screen.getByTestId("run-issue-adapter-agent-team")
    expect(team).toHaveAttribute("aria-checked", "true")
    expect(team).toHaveTextContent("run.adapter.agent-team.description")
    expect(screen.queryByTestId("run-issue-base")).not.toBeInTheDocument()
  })

  it("dispatches through startIssueRun with the interactive origin and closes", async () => {
    const user = userEvent.setup()
    const { props } = renderDialog()
    await screen.findByTestId("run-issue-adapter-agent-team")
    await user.click(screen.getByTestId("run-issue-submit"))
    await waitFor(() =>
      expect(mockStart).toHaveBeenCalledWith({
        issueId: "iss-1",
        adapterId: "agent-team",
        by: { kind: "human" },
        origin: "interactive",
      })
    )
    expect(mockToastSuccess).toHaveBeenCalledWith("run.started:MERC-1,run.adapter.agent-team.name")
    expect(props.onStarted).toHaveBeenCalledWith({ id: "run-1", adapterId: "agent-team" })
    expect(props.onOpenChange).toHaveBeenCalledWith(false)
  })

  it("passes the base branch option for the GitHub loop", async () => {
    const user = userEvent.setup()
    renderDialog()
    await user.click(await screen.findByTestId("run-issue-adapter-github-loop"))
    const base = screen.getByTestId("run-issue-base")
    await user.clear(base)
    await user.type(base, "develop")
    await user.click(screen.getByTestId("run-issue-submit"))
    await waitFor(() =>
      expect(mockStart).toHaveBeenCalledWith(
        expect.objectContaining({ adapterId: "github-loop", options: { base: "develop" } })
      )
    )
  })

  it("localizes a refusal and shows other errors verbatim", async () => {
    const user = userEvent.setup()
    mockStart.mockRejectedValueOnce(new IssueRunRefusedError("run-active"))
    renderDialog()
    await screen.findByTestId("run-issue-adapter-agent-team")
    await user.click(screen.getByTestId("run-issue-submit"))
    expect(await screen.findByTestId("run-issue-error")).toHaveTextContent("run.refusal.run-active")
    mockStart.mockRejectedValueOnce(new Error("engine down"))
    await user.click(screen.getByTestId("run-issue-submit"))
    expect(await screen.findByTestId("run-issue-error")).toHaveTextContent("engine down")
  })

  it("explains when nothing can run", async () => {
    mockListOptions.mockResolvedValue([])
    renderDialog()
    expect(await screen.findByTestId("run-issue-empty")).toBeInTheDocument()
    expect(screen.getByTestId("run-issue-submit")).toBeDisabled()
  })
})

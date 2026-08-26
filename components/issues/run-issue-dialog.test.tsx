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

// The stack picker asks the database what sibling issues already pushed. Stub
// the three reads at their own seam so the dialog's own logic is what is tested.
let mockIssue: unknown = {
  id: "iss-1",
  projectId: "w1",
  issueProjectId: "ip-1",
  githubRef: { repoFullName: "octo/repo", number: 1 },
}
let mockProject: unknown = {
  id: "ip-1",
  resources: [{ kind: "github-repo", repoFullName: "octo/repo", addedAt: 1 }],
}
let mockRuns: unknown[] = []
jest.mock("@/lib/db/issues", () => ({ getIssue: async () => mockIssue }))
jest.mock("@/lib/db/issue-projects", () => ({ getIssueProject: async () => mockProject }))
jest.mock("@/lib/db/issue-runs", () => ({ listIssueRuns: async () => mockRuns }))

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

describe("stacked runs", () => {
  const pushed = (issueId: string, head: string) => ({
    id: `run-${head}`,
    issueId,
    projectId: "w1",
    adapterId: "github-loop",
    kind: "github-loop",
    targetId: "job",
    targetRef: { repoFullName: "octo/repo", head, base: "main" },
    status: "succeeded",
    by: { kind: "human" },
    startedAt: 1,
    updatedAt: 2,
    endedAt: 2,
    artifacts: [],
  })

  beforeEach(() => {
    mockRuns = []
    mockIssue = {
      id: "iss-1",
      projectId: "w1",
      issueProjectId: "ip-1",
      githubRef: { repoFullName: "octo/repo", number: 1 },
    }
    mockProject = {
      id: "ip-1",
      resources: [{ kind: "github-repo", repoFullName: "octo/repo", addedAt: 1 }],
    }
  })

  it("hides the picker when there is no branch to stack on", async () => {
    mockListOptions.mockResolvedValue([{ adapter: adapters.loop, verdict: { ok: true } }])
    renderDialog()
    await screen.findByTestId("run-issue-base")
    expect(screen.queryByTestId("run-issue-stack")).toBeNull()
  })

  it("offers a sibling issue's pushed branch and sends it as the stack option", async () => {
    mockRuns = [pushed("iss-2", "issue/merc-2")]
    mockListOptions.mockResolvedValue([{ adapter: adapters.loop, verdict: { ok: true } }])
    mockStart.mockResolvedValue({ adapterId: "github-loop" })
    renderDialog()

    const picker = await screen.findByTestId("run-issue-stack")
    await userEvent.click(picker)
    await userEvent.click(await screen.findByRole("option", { name: "issue/merc-2" }))

    await userEvent.click(screen.getByTestId("run-issue-submit"))
    await waitFor(() =>
      expect(mockStart).toHaveBeenCalledWith(
        expect.objectContaining({
          options: expect.objectContaining({ stackOn: "issue/merc-2" }),
        })
      )
    )
  })

  it("locks the base field to the stack branch, because a PR has one base", async () => {
    mockRuns = [pushed("iss-2", "issue/merc-2")]
    mockListOptions.mockResolvedValue([{ adapter: adapters.loop, verdict: { ok: true } }])
    renderDialog()

    const base = await screen.findByTestId("run-issue-base")
    expect(base).not.toBeDisabled()

    await userEvent.click(screen.getByTestId("run-issue-stack"))
    await userEvent.click(await screen.findByRole("option", { name: "issue/merc-2" }))

    await waitFor(() => expect(screen.getByTestId("run-issue-base")).toBeDisabled())
    expect(screen.getByTestId("run-issue-base")).toHaveValue("issue/merc-2")
  })

  it("sends no stack option when the run is not stacked", async () => {
    mockRuns = [pushed("iss-2", "issue/merc-2")]
    mockListOptions.mockResolvedValue([{ adapter: adapters.loop, verdict: { ok: true } }])
    mockStart.mockResolvedValue({ adapterId: "github-loop" })
    renderDialog()
    await screen.findByTestId("run-issue-stack")
    await userEvent.click(screen.getByTestId("run-issue-submit"))
    await waitFor(() => expect(mockStart).toHaveBeenCalled())
    const [[call]] = mockStart.mock.calls
    expect(call.options).not.toHaveProperty("stackOn")
  })
})

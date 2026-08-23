import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { RunDetailPane } from "./run-detail-pane"
import type { RunControlActions } from "@/hooks/agent-runs/use-agent-run-actions"
import type { UnifiedExecutionRow } from "@/lib/execution/monitor-model"
import type { RunDetailProjection } from "@/lib/execution/run-detail-model"

jest.mock("next-intl", () => ({
  useTranslations: (namespace?: string) => (key: string, values?: Record<string, unknown>) => {
    const full = namespace === "agentRuns.status" ? `status.${key}` : key
    return values ? `${full}:${JSON.stringify(values)}` : full
  },
}))

let detailState: Record<string, unknown>
jest.mock("@/hooks/agent-runs/use-execution-run-detail", () => ({
  useExecutionRunDetail: () => detailState,
}))

function emptyDetail(over: Partial<RunDetailProjection> = {}): RunDetailProjection {
  return {
    activities: [],
    omittedActivityCount: 0,
    artifacts: [],
    verifications: [],
    changes: [],
    ...over,
  }
}

function row(over: Partial<UnifiedExecutionRow> = {}): UnifiedExecutionRow {
  return {
    rowId: "journal:run-1",
    source: "journal",
    nativeId: "run-1",
    kind: "agent-turn",
    label: "Chat run",
    status: "running",
    startedAt: Date.now(),
    runId: "run-1",
    cancellable: false,
    allowedActions: ["stop", "open_details"],
    ...over,
  }
}

function makeActions(over: Partial<RunControlActions> = {}): RunControlActions {
  return {
    pendingRowId: null,
    can: (r, action) => (r.allowedActions ?? []).includes(action),
    dispatch: jest.fn().mockResolvedValue({ accepted: true }),
    ...over,
  }
}

beforeEach(() => {
  detailState = {
    run: undefined,
    detail: emptyDetail(),
    interrupts: [],
    journalAvailable: true,
    isLoading: false,
  }
})

describe("RunDetailPane", () => {
  it("renders a control button for every allowed verb and none besides", () => {
    render(
      <RunDetailPane row={row({ allowedActions: ["pause", "stop"] })} actions={makeActions()} />
    )
    expect(screen.getByRole("button", { name: "actions.pause" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "actions.stop" })).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "actions.resume" })).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "actions.retry" })).not.toBeInTheDocument()
  })

  it("dispatches the verb that was pressed", async () => {
    const actions = makeActions()
    render(<RunDetailPane row={row()} actions={actions} />)
    fireEvent.click(screen.getByRole("button", { name: "actions.stop" }))
    await waitFor(() => expect(actions.dispatch).toHaveBeenCalled())
    expect(actions.dispatch).toHaveBeenCalledWith(expect.anything(), "stop", {})
  })

  it("disables the controls while a command is in flight", () => {
    render(<RunDetailPane row={row()} actions={makeActions({ pendingRowId: "journal:run-1" })} />)
    expect(screen.getByRole("button", { name: "actions.stop" })).toBeDisabled()
  })

  it("surfaces a refusal instead of failing silently", async () => {
    const actions = makeActions({
      dispatch: jest.fn().mockResolvedValue({ accepted: false, reason: "revision_conflict" }),
    })
    render(<RunDetailPane row={row()} actions={actions} />)
    fireEvent.click(screen.getByRole("button", { name: "actions.stop" }))
    expect(await screen.findByRole("status")).toHaveTextContent("outcome.revision_conflict")
  })

  it("names the degradation when a steer could not be delivered", async () => {
    const actions = makeActions({
      can: () => true,
      dispatch: jest.fn().mockResolvedValue({
        accepted: false,
        reason: "steer_degraded",
        degradedReason: "no_active_run",
      }),
    })
    render(<RunDetailPane row={row({ allowedActions: ["steer"] })} actions={actions} />)
    fireEvent.change(screen.getByLabelText("actions.steerPlaceholder"), {
      target: { value: "focus on the tests" },
    })
    fireEvent.click(screen.getByRole("button", { name: "actions.steer" }))
    expect(await screen.findByRole("status")).toHaveTextContent("degraded.no_active_run")
  })

  /** The message is still the user's — clearing it would drop what they typed. */
  it("keeps the steer text when the steer was not accepted", async () => {
    const actions = makeActions({
      can: (_r, a) => a === "steer",
      dispatch: jest.fn().mockResolvedValue({ accepted: false, reason: "steer_degraded" }),
    })
    render(<RunDetailPane row={row({ allowedActions: ["steer"] })} actions={actions} />)
    const input = screen.getByLabelText("actions.steerPlaceholder") as HTMLInputElement
    fireEvent.change(input, { target: { value: "keep me" } })
    fireEvent.click(screen.getByRole("button", { name: "actions.steer" }))
    await screen.findByRole("status")
    expect(input.value).toBe("keep me")
  })

  it("clears the steer box once the message was accepted", async () => {
    const actions = makeActions({ can: (_r, a) => a === "steer" })
    render(<RunDetailPane row={row({ allowedActions: ["steer"] })} actions={actions} />)
    const input = screen.getByLabelText("actions.steerPlaceholder") as HTMLInputElement
    fireEvent.change(input, { target: { value: "go" } })
    fireEvent.click(screen.getByRole("button", { name: "actions.steer" }))
    await waitFor(() => expect(input.value).toBe(""))
  })

  it("offers no steer box on a kind with no live input lane", () => {
    render(<RunDetailPane row={row({ allowedActions: ["stop"] })} actions={makeActions()} />)
    expect(screen.queryByLabelText("actions.steerPlaceholder")).not.toBeInTheDocument()
  })

  it("shows a verification result with its counts", async () => {
    detailState = {
      ...detailState,
      detail: emptyDetail({
        verifications: [
          {
            id: "v1",
            title: "Tests",
            kind: "verification",
            verification: { conclusion: "failed", passed: 3, failed: 1, skipped: 0, total: 4 },
          },
        ],
      }),
    }
    render(<RunDetailPane row={row()} actions={makeActions()} />)
    await userEvent.setup().click(screen.getByRole("tab", { name: /tabs\.tests/ }))
    expect(screen.getByText("tests.failed")).toBeInTheDocument()
    expect(screen.getByText(/"failed":1/)).toBeInTheDocument()
  })

  /** A silent green on unparseable output is the failure this whole path avoids. */
  it("says inconclusive out loud rather than printing 0 failed", async () => {
    detailState = {
      ...detailState,
      detail: emptyDetail({
        verifications: [
          {
            id: "v1",
            title: "Tests",
            kind: "verification",
            verification: {
              conclusion: "inconclusive",
              passed: 0,
              failed: 0,
              skipped: 0,
              total: 0,
            },
          },
        ],
      }),
    }
    render(<RunDetailPane row={row()} actions={makeActions()} />)
    await userEvent.setup().click(screen.getByRole("tab", { name: /tabs\.tests/ }))
    expect(screen.getByText("tests.inconclusive")).toBeInTheDocument()
    expect(screen.getByText("tests.inconclusiveHint")).toBeInTheDocument()
    expect(screen.queryByText(/"failed":0/)).not.toBeInTheDocument()
  })

  it("lists changed paths and flags the sensitive ones", async () => {
    detailState = {
      ...detailState,
      detail: emptyDetail({
        changes: [
          { path: "src/a.ts", changeKind: "modified", sensitive: false },
          { path: ".env", changeKind: "modified", sensitive: true },
        ],
      }),
    }
    render(<RunDetailPane row={row()} actions={makeActions()} />)
    await userEvent.setup().click(screen.getByRole("tab", { name: /tabs\.changes/ }))
    expect(screen.getByText("src/a.ts")).toBeInTheDocument()
    expect(screen.getByText(".env")).toBeInTheDocument()
    expect(screen.getByText("detail.sensitive")).toBeInTheDocument()
  })

  it("warns when the change list is known to be incomplete", async () => {
    detailState = {
      ...detailState,
      detail: emptyDetail({
        changes: [{ path: "src/a.ts", sensitive: false }],
        changeSummary: {
          counts: {},
          eventCount: 1,
          overflowCount: 9,
          completeness: "complete",
        },
      }),
    }
    render(<RunDetailPane row={row()} actions={makeActions()} />)
    await userEvent.setup().click(screen.getByRole("tab", { name: /tabs\.changes/ }))
    expect(screen.getByText("detail.changesIncomplete")).toBeInTheDocument()
  })

  /**
   * On a device that never received the journal, an empty Changes list would
   * claim the run touched no files.
   */
  it("says the journal is unavailable rather than showing an empty change list", async () => {
    detailState = { ...detailState, journalAvailable: false }
    render(<RunDetailPane row={row()} actions={makeActions()} />)
    await userEvent.setup().click(screen.getByRole("tab", { name: /tabs\.changes/ }))
    expect(screen.getByText("detail.journalUnavailable")).toBeInTheDocument()
    expect(screen.queryByText("detail.noChanges")).not.toBeInTheDocument()
  })

  it("distinguishes an unavailable journal from a run that changed nothing", async () => {
    render(<RunDetailPane row={row()} actions={makeActions()} />)
    await userEvent.setup().click(screen.getByRole("tab", { name: /tabs\.changes/ }))
    expect(screen.getByText("detail.noChanges")).toBeInTheDocument()
  })

  it("lists approvals with their outcome", async () => {
    detailState = {
      ...detailState,
      interrupts: [
        { id: "i1", runId: "run-1", title: "Run tests?", status: "denied", createdAt: Date.now() },
      ],
    }
    render(<RunDetailPane row={row()} actions={makeActions()} />)
    await userEvent.setup().click(screen.getByRole("tab", { name: /tabs\.approvals/ }))
    expect(screen.getByText("Run tests?")).toBeInTheDocument()
    expect(screen.getByText("approvals.denied")).toBeInTheDocument()
  })

  it("reports the activity the rolling window dropped", async () => {
    detailState = {
      ...detailState,
      detail: emptyDetail({
        activities: [
          {
            id: "a1",
            kind: "tool",
            category: "command",
            status: "completed",
            label: "pnpm test",
            startedAt: 1,
          },
        ],
        omittedActivityCount: 7,
      }),
    }
    render(<RunDetailPane row={row()} actions={makeActions()} />)
    await userEvent.setup().click(screen.getByRole("tab", { name: /tabs\.activity/ }))
    expect(screen.getByText("activityCategory.command")).toBeInTheDocument()
    expect(screen.getByText(/detail\.activityOmitted.*7/)).toBeInTheDocument()
  })

  it("explains why a legacy row has no controls", () => {
    render(
      <RunDetailPane
        row={row({ source: "legacy", allowedActions: undefined })}
        actions={makeActions()}
      />
    )
    expect(screen.getByText("detail.notJournalled")).toBeInTheDocument()
  })

  it("shows the run status in the overview", () => {
    render(<RunDetailPane row={row()} actions={makeActions()} />)
    const overview = screen.getByRole("tabpanel")
    expect(within(overview).getByText("status.running")).toBeInTheDocument()
  })
})

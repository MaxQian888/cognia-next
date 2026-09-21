import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { RunDetailPane } from "./run-detail-pane"
import type { RunControlActions } from "@/hooks/agent-runs/use-agent-run-actions"
import type { UnifiedExecutionRow } from "@/lib/execution/monitor-model"
import type { RunDetailProjection } from "@/lib/execution/run-detail-model"
jest.mock("@/components/source-control/diff-viewer", () => ({
  DiffViewer: ({ diff }: { diff: { oldContent: string; newContent: string } }) => (
    <pre data-testid="approval-diff">
      {diff.oldContent}
      {diff.newContent}
    </pre>
  ),
}))

jest.mock("next-intl", () => ({
  useTranslations: (namespace?: string) => (key: string, values?: Record<string, unknown>) => {
    const full = namespace === "agentRuns.status" ? `status.${key}` : key
    return values ? `${full}:${JSON.stringify(values)}` : full
  },
}))

let detailState: Record<string, unknown>
jest.mock("./squad-review-form", () => ({
  isRenderableSquadReview: (interrupt: { reviewKind?: string }) =>
    interrupt.reviewKind !== undefined,
  SquadReviewForm: ({
    interrupt,
    onDecide,
  }: {
    interrupt: { reviewKind: string }
    onDecide: (action: string, decision: unknown) => void
  }) => (
    <button
      type="button"
      data-testid="squad-review-form"
      onClick={() => onDecide("approve", { kind: interrupt.reviewKind, extraTokens: 5000 })}
    >
      form:{interrupt.reviewKind}
    </button>
  ),
}))
jest.mock("@/hooks/agent-runs/use-execution-run-detail", () => ({
  useExecutionRunDetail: () => detailState,
}))
// The delegate review reads the fusion database behind the gate; its own test
// covers that. Here the contract is the mount: which run kind gets it, which
// interrupt it is handed, and that it owns approve / deny.
jest.mock("./delegate-review-pane", () => ({
  isFusionApprovalInterrupt: (interrupt: { type?: string } | null | undefined) =>
    interrupt?.type === "fusion_approval",
  DelegateReviewPane: ({
    runId,
    interrupt,
    onDecide,
  }: {
    runId: string
    interrupt?: { id: string } | null
    onDecide?: (action: "approve" | "deny") => void
  }) => (
    <button type="button" data-testid="delegate-review-pane" onClick={() => onDecide?.("approve")}>
      pane:{runId}:{interrupt?.id ?? "none"}
    </button>
  ),
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
  it.each(["completed", "approval"])(
    "shows saved Bot Changes and Tests for %s runs",
    async (phase) => {
      const evidence = {
        snapshot: {
          id: "snapshot",
          baseSha: "base",
          headSha: "head",
          files: [
            {
              path: "navigation.test.ts",
              oldContent: "10 tests",
              newContent: "40 tests",
              mode: "100644",
            },
          ],
        },
        report: {
          tests: [
            { command: "pnpm test --runInBand", exitCode: 0, output: "40 passed" },
            { command: "pnpm lint", exitCode: 1, output: "Lint failed" },
          ],
        },
        testEvidence: "agent-reported",
      }
      if (phase === "completed")
        detailState.botResult = { output: { status: "published", ...evidence } }
      else {
        detailState.run = { latestSnapshot: { pendingInterrupt: { id: "approval" } } }
        detailState.interrupts = [
          { id: "approval", type: "bot_approval", status: "pending", approvalDetail: evidence },
        ]
      }
      render(<RunDetailPane row={row({ kind: "bot" })} actions={makeActions()} />)
      const user = userEvent.setup()
      expect(screen.getByRole("tab", { name: /tabs\.changes/ })).toHaveTextContent("1")
      expect(screen.getByRole("tab", { name: /tabs\.tests/ })).toHaveTextContent("2")
      await user.click(screen.getByRole("tab", { name: /tabs\.changes/ }))
      const changes = screen.getByRole("tabpanel", { name: /tabs\.changes/ })
      expect(within(changes).getByText("navigation.test.ts")).toBeVisible()
      expect(within(changes).getByTestId("approval-diff")).toHaveTextContent("10 tests40 tests")
      expect(within(changes).queryByText("detail.noChanges")).not.toBeInTheDocument()
      await user.click(screen.getByRole("tab", { name: /tabs\.tests/ }))
      const tests = screen.getByRole("tabpanel", { name: /tabs\.tests/ })
      expect(within(tests).getByText("pnpm test --runInBand")).toBeVisible()
      expect(within(tests).getByText("40 passed")).toBeVisible()
      expect(within(tests).getByText("Lint failed")).toBeVisible()
      expect(within(tests).getByText("botApproval.agentReported")).toBeVisible()
      expect(within(tests).queryByText("detail.noTests")).not.toBeInTheDocument()
      expect(within(tests).queryByText(/tests.counts/)).not.toBeInTheDocument()
    }
  )

  it("uses authoritative final Bot evidence without duplicating generic changed paths", async () => {
    detailState.journalAvailable = false
    detailState.detail = emptyDetail({
      changes: [
        { path: "file.ts", sensitive: false },
        { path: "other.ts", sensitive: false },
      ],
    })
    detailState.botResult = {
      output: {
        snapshot: {
          id: "final",
          files: [{ path: "file.ts", oldContent: "before", newContent: "after" }],
        },
      },
    }
    render(<RunDetailPane row={row({ kind: "bot" })} actions={makeActions()} />)
    expect(screen.getByRole("tab", { name: /tabs\.changes/ })).toHaveTextContent("2")
    await userEvent.setup().click(screen.getByRole("tab", { name: /tabs\.changes/ }))
    expect(screen.getAllByText("file.ts")).toHaveLength(1)
    expect(screen.getByText("other.ts")).toBeVisible()
    expect(screen.queryByText("detail.journalUnavailable")).not.toBeInTheDocument()
  })

  it("retains raw diff-only snapshots and distinguishes capture failure from no changes", async () => {
    detailState.botResult = {
      output: { snapshot: { id: "raw", files: [], diff: "+retained patch" } },
    }
    const view = render(<RunDetailPane row={row({ kind: "bot" })} actions={makeActions()} />)
    await userEvent.setup().click(screen.getByRole("tab", { name: /tabs\.changes/ }))
    expect(screen.getByText("+retained patch")).toBeVisible()
    detailState.botResult = { output: { snapshotError: "Snapshot too large" } }
    view.rerender(<RunDetailPane row={row({ kind: "bot" })} actions={makeActions()} />)
    expect(screen.getByText(/Snapshot too large/)).toBeVisible()
    expect(screen.queryByText("detail.noChanges")).not.toBeInTheDocument()
  })

  it("does not infer successful tests from malformed Bot report entries", async () => {
    detailState.botResult = {
      output: { report: { tests: [{ command: "test", exitCode: "0", output: "passed" }] } },
    }
    render(<RunDetailPane row={row({ kind: "bot" })} actions={makeActions()} />)
    await userEvent.setup().click(screen.getByRole("tab", { name: /tabs\.tests/ }))
    expect(screen.getByText("detail.noTests")).toBeVisible()
    expect(screen.queryByText("tests.passed")).not.toBeInTheDocument()
  })
  it("shows a concrete Bot command request separately from publication approval", () => {
    detailState.interrupts = [
      {
        id: "command-approval",
        type: "bot_approval",
        status: "pending",
        title: "Run tests",
        approvalDetail: {
          model: "swe-2-medium",
          externalAgent: { toolName: "exec", input: { command: "pnpm test --runInBand" } },
          command: { command: "pnpm test --runInBand", cwd: "/owned/checkout" },
        },
      },
    ]
    detailState.run = {
      id: "run-1",
      currentRevision: 2,
      latestSnapshot: {
        pendingInterrupt: { id: "command-approval" },
        allowedActions: ["approve", "deny"],
      },
    }
    render(<RunDetailPane row={row({ kind: "bot" })} actions={makeActions()} />)
    const region = screen.getByRole("region", { name: "botApproval.commandTitle" })
    expect(within(region).getByText(/pnpm test --runInBand/)).toBeVisible()
    expect(within(region).getByText("botApproval.command")).toBeVisible()
    expect(within(region).queryByText("botApproval.publication")).not.toBeInTheDocument()
    expect(within(region).getByRole("button", { name: "actions.approve" })).toBeEnabled()
  })

  it("shows retained blocked Bot patches and command evidence without an approval", async () => {
    detailState = {
      ...detailState,
      botResult: {
        summary: "Fork publication is blocked; patch retained",
        output: {
          status: "blocked",
          model: "swe-2-medium",
          testEvidence: "agent-reported",
          report: { tests: [{ command: "pnpm test", exitCode: 0 }] },
          snapshot: {
            id: "retained",
            baseSha: "base",
            headSha: "head",
            files: [{ path: "run.sh", oldContent: "exit 1", newContent: "exit 0", mode: "100755" }],
          },
        },
      },
    }
    render(<RunDetailPane row={row({ kind: "bot" })} actions={makeActions()} />)
    await userEvent.setup().click(screen.getByRole("tab", { name: /tabs\.artifacts/ }))
    expect(screen.getByText("Fork publication is blocked; patch retained")).toBeInTheDocument()
    expect(screen.getByTestId("approval-diff")).toHaveTextContent("exit 0")
    expect(screen.getByText("100755")).toBeInTheDocument()
    expect(screen.getByText("botApproval.agentReported")).toBeInTheDocument()
    expect(screen.getByText(/pnpm test/)).toBeInTheDocument()
    expect(screen.queryByText("detail.noArtifacts")).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "actions.approve" })).not.toBeInTheDocument()
  })

  it("renders scalar Bot results without assuming a patch schema", async () => {
    detailState = { ...detailState, botResult: { summary: "Diagnostic", output: ["pending", 2] } }
    render(<RunDetailPane row={row({ kind: "bot" })} actions={makeActions()} />)
    await userEvent.setup().click(screen.getByRole("tab", { name: /tabs\.artifacts/ }))
    expect(screen.getByText(/"pending"/)).toBeInTheDocument()
  })

  it("shows immutable Bot contents with adjacent decisions through the shared control path", async () => {
    const interrupt = {
      id: "approval",
      type: "bot_approval",
      status: "pending",
      title: "Publish repair",
      createdAt: Date.now(),
      approvalDetail: {
        snapshot: {
          id: "snapshot",
          baseSha: "base-sha",
          headSha: "head-sha",
          files: [{ path: "a.ts", oldContent: "old code", newContent: "new code" }],
        },
        model: "swe-2-medium",
        sessionId: "session-1",
        testEvidence: "agent-reported",
        report: { tests: [{ command: "pnpm test", exitCode: 0 }] },
        approvedActions: [{ actionId: "createComment", input: { body: "Exact review text" } }],
      },
    }
    detailState.interrupts = [interrupt]
    detailState.run = {
      id: "run-1",
      currentRevision: 12,
      latestSnapshot: {
        pendingInterrupt: { id: "approval" },
        allowedActions: ["approve", "deny", "stop"],
      },
    }
    const actions = makeActions()
    render(<RunDetailPane row={row({ kind: "bot", allowedActions: ["stop"] })} actions={actions} />)
    const region = screen.getByRole("region", { name: "botApproval.title" })
    expect(within(region).getByTestId("approval-diff")).toHaveTextContent("old codenew code")
    expect(within(region).getByText("swe-2-medium")).toBeVisible()
    expect(within(region).getByText(/Exact review text/)).toBeVisible()
    expect(within(region).getByText("botApproval.agentReported")).toBeVisible()
    fireEvent.click(within(region).getByRole("button", { name: "actions.approve" }))
    await waitFor(() =>
      expect(actions.dispatch).toHaveBeenCalledWith(expect.anything(), "approve", {
        reviewedRun: detailState.run,
      })
    )
  })

  it("hides bare Bot approval verbs when concrete detail is unavailable", () => {
    detailState.interrupts = [
      {
        id: "approval",
        type: "bot_approval",
        status: "pending",
        title: "Pending",
        createdAt: Date.now(),
      },
    ]
    detailState.run = {
      id: "run-1",
      currentRevision: 12,
      latestSnapshot: {
        pendingInterrupt: { id: "approval" },
        allowedActions: ["approve", "deny", "stop"],
      },
    }
    render(
      <RunDetailPane
        row={row({ kind: "bot", allowedActions: ["approve", "deny", "stop"] })}
        actions={makeActions()}
      />
    )
    expect(screen.queryByRole("button", { name: "actions.approve" })).not.toBeInTheDocument()
    expect(screen.getByText("botApproval.detailUnavailable")).toBeVisible()
    expect(screen.getByRole("button", { name: "actions.stop" })).toBeVisible()
  })

  it("renders the declared approval risk as a badge only when present", () => {
    detailState.interrupts = [
      {
        id: "approval",
        type: "bot_approval",
        status: "pending",
        title: "Publish repair",
        createdAt: Date.now(),
        approvalRisk: "high",
        approvalDetail: { approvedActions: [{ input: { body: "Exact" } }] },
      },
    ]
    detailState.run = {
      id: "run-1",
      currentRevision: 12,
      latestSnapshot: {
        pendingInterrupt: { id: "approval" },
        allowedActions: ["approve", "deny", "stop"],
      },
    }
    const { unmount } = render(<RunDetailPane row={row({ kind: "bot" })} actions={makeActions()} />)
    const region = screen.getByRole("region", { name: "botApproval.title" })
    const badge = within(region).getByText("botApproval.risk.high")
    expect(badge).toHaveAttribute("data-variant", "destructive")
    unmount()

    const [first] = detailState.interrupts as Array<Record<string, unknown>>
    detailState.interrupts = [{ ...first, approvalRisk: undefined }]
    render(<RunDetailPane row={row({ kind: "bot" })} actions={makeActions()} />)
    expect(screen.queryByText(/botApproval\.risk\./)).not.toBeInTheDocument()
  })

  it("keeps historical Bot publication detail readable in approvals", async () => {
    detailState.interrupts = [
      {
        id: "old",
        type: "bot_approval",
        status: "approved",
        title: "Earlier publication",
        createdAt: Date.now(),
        approvalDetail: { approvedActions: [{ input: { body: "Historical exact comment" } }] },
      },
    ]
    render(<RunDetailPane row={row({ kind: "bot" })} actions={makeActions()} />)
    await userEvent.click(screen.getByRole("tab", { name: /tabs.approvals/ }))
    expect(screen.getByText(/Historical exact comment/)).toBeVisible()
  })
  it("links a mirrored run to its conversation without requiring an IM binding", () => {
    render(<RunDetailPane row={row({ sessionId: "chat-a" })} actions={makeActions()} />)
    expect(screen.getByRole("link", { name: "actions.openConversation" })).toHaveAttribute(
      "href",
      "/?session=chat-a"
    )
  })

  it("renders a control button for every allowed verb and none besides", () => {
    render(
      <RunDetailPane row={row({ allowedActions: ["pause", "stop"] })} actions={makeActions()} />
    )
    expect(screen.getByRole("button", { name: "actions.pause" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "actions.stop" })).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "actions.resume" })).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "actions.retry" })).not.toBeInTheDocument()
  })

  it("shows a host authorization challenge when a control click needs consent", async () => {
    const actions = makeActions({
      dispatch: jest.fn().mockResolvedValue({
        accepted: false,
        reason: "host_consent_required",
        consentCode: "TEST-4821",
      }),
    })
    render(<RunDetailPane row={row()} actions={actions} />)
    fireEvent.click(screen.getByRole("button", { name: "actions.stop" }))
    const status = await screen.findByRole("status")
    expect(status).toHaveTextContent("outcome.host_consent_required")
    expect(status).toHaveTextContent("TEST-4821")
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

  it("hands approve / deny to the typed review form when the pending interrupt is a Squad review", async () => {
    detailState = {
      ...detailState,
      run: {
        id: "run-1",
        kind: "team",
        sourceId: "team-run-1",
        title: "t",
        status: "waiting_input",
        currentRevision: 3,
        startedAt: 1,
        updatedAt: 2,
        latestSnapshot: {
          runId: "run-1",
          revision: 3,
          status: "waiting_input",
          elapsedMs: 1,
          artifacts: [],
          allowedActions: ["approve", "deny", "stop", "open_details"],
          pendingInterrupt: { id: "i-budget", title: "Approval required", type: "squad_budget" },
        },
      } as never,
      interrupts: [
        {
          id: "i-budget",
          runId: "run-1",
          type: "squad_budget",
          reviewKind: "budget_extension",
          title: "Budget",
          status: "pending",
          createdAt: Date.now(),
          expiresAt: Date.now() + 60_000,
        } as never,
      ],
    }
    const dispatch = jest.fn().mockResolvedValue({ accepted: true })
    render(
      <RunDetailPane
        row={row({ allowedActions: ["approve", "deny", "stop", "open_details"] })}
        actions={makeActions({ dispatch })}
      />
    )
    expect(screen.queryByRole("button", { name: "actions.approve" })).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "actions.deny" })).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: "actions.stop" })).toBeInTheDocument()
    await userEvent.setup().click(screen.getByTestId("squad-review-form"))
    expect(dispatch).toHaveBeenCalledWith(expect.anything(), "approve", {
      reviewDecision: { kind: "budget_extension", extraTokens: 5000 },
      reviewedRun: detailState.run,
    })
  })

  it("hands approve / deny to the delegate review when a fusion run is parked on one", async () => {
    detailState = {
      ...detailState,
      run: {
        id: "run-9",
        kind: "fusion",
        sourceId: "run-9",
        title: "Delegation",
        status: "waiting_input",
        currentRevision: 4,
        startedAt: 1,
        updatedAt: 2,
        latestSnapshot: {
          runId: "run-9",
          revision: 4,
          status: "waiting_input",
          elapsedMs: 1,
          artifacts: [],
          allowedActions: ["approve", "deny", "stop", "open_details"],
          pendingInterrupt: { id: "fusion-approval-1", title: "Approval required" },
        },
      } as never,
      interrupts: [
        {
          id: "fusion-approval-1",
          runId: "run-9",
          type: "fusion_approval",
          title: "Router + Fusion approval",
          status: "pending",
          requestDigest: "d".repeat(64),
          createdAt: Date.now(),
          expiresAt: Date.now() + 60_000,
        } as never,
      ],
    }
    const dispatch = jest.fn().mockResolvedValue({ accepted: true })
    render(
      <RunDetailPane
        row={row({
          kind: "fusion",
          runId: "run-9",
          allowedActions: ["approve", "deny", "stop", "open_details"],
        })}
        actions={makeActions({ dispatch })}
      />
    )
    expect(screen.getByTestId("delegate-review-pane")).toHaveTextContent(
      "pane:run-9:fusion-approval-1"
    )
    expect(screen.queryByRole("button", { name: "actions.approve" })).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "actions.deny" })).not.toBeInTheDocument()
    await userEvent.setup().click(screen.getByTestId("delegate-review-pane"))
    expect(dispatch).toHaveBeenCalledWith(expect.anything(), "approve", {
      reviewedRun: detailState.run,
    })
  })

  it("mounts no delegate review for a run of another kind", () => {
    render(<RunDetailPane row={row()} actions={makeActions()} />)
    expect(screen.queryByTestId("delegate-review-pane")).not.toBeInTheDocument()
  })

  it("keeps the bare approve / deny for a pending interrupt that is not a Squad review", () => {
    detailState = {
      ...detailState,
      run: {
        id: "run-1",
        kind: "agent-turn",
        sourceId: "s",
        title: "t",
        status: "waiting_input",
        currentRevision: 3,
        startedAt: 1,
        updatedAt: 2,
        latestSnapshot: {
          runId: "run-1",
          revision: 3,
          status: "waiting_input",
          elapsedMs: 1,
          artifacts: [],
          allowedActions: ["approve", "deny", "open_details"],
          pendingInterrupt: { id: "i-tool", title: "Approval required", type: "tool_approval" },
        },
      } as never,
      interrupts: [
        {
          id: "i-tool",
          runId: "run-1",
          type: "tool_approval",
          title: "Run tests?",
          status: "pending",
          createdAt: Date.now(),
          expiresAt: Date.now() + 60_000,
        } as never,
      ],
    }
    render(
      <RunDetailPane
        row={row({ allowedActions: ["approve", "deny", "open_details"] })}
        actions={makeActions()}
      />
    )
    expect(screen.getByRole("button", { name: "actions.approve" })).toBeInTheDocument()
    expect(screen.queryByTestId("squad-review-form")).not.toBeInTheDocument()
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

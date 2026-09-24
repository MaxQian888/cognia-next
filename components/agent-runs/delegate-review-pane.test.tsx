/**
 * @jest-environment jsdom
 */

import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

jest.mock("@/components/source-control/diff-viewer", () => ({
  DiffViewer: ({ diff }: { diff: { path: string } }) => <pre data-testid={`diff-${diff.path}`} />,
}))
const mockToast = { success: jest.fn(), error: jest.fn() }
jest.mock("sonner", () => ({
  toast: {
    success: (...args: unknown[]) => mockToast.success(...args),
    error: (...args: unknown[]) => mockToast.error(...args),
  },
}))

import { DelegateReviewPane, isFusionApprovalInterrupt } from "./delegate-review-pane"
import type {
  DelegateApprovalView,
  DelegateReview,
  DelegateReviewState,
} from "@/components/router-fusion/delegate-review-model"
import type { ExecutionRunInterrupt } from "@/types/execution/run"

function approvalView(over: Partial<DelegateApprovalView> = {}): DelegateApprovalView {
  return {
    id: "approval-1",
    kind: "workspace_apply",
    status: "pending",
    requestDigest: "d".repeat(64),
    revision: "git:abc",
    paths: ["src/a.ts"],
    fileCount: 1,
    createdAt: 20,
    decidedAt: null,
    ...over,
  }
}

function review(over: Partial<DelegateReview> = {}): DelegateReview {
  return {
    runId: "run-1",
    status: "waiting_for_approval",
    patch: {
      patchSetId: "patch-1",
      baseRevision: "git:abc",
      resultRevision: "staged:def",
      patchSha256: "a".repeat(64),
      patchArtifactId: "artifact-1",
      fileCount: 1,
      paths: ["src/a.ts"],
      delivery: "workspace_updated",
      appliedRevision: null,
      appliedAt: null,
      document: '{"format":"cognia-delegate-patch-1"}',
      comparedRevision: "git:abc",
      comparedAtBase: true,
      files: [
        {
          path: "src/a.ts",
          action: "write",
          newContent: "next\n",
          baseContent: "previous\n",
          baseState: "read",
          unchanged: false,
        },
      ],
    },
    acceptance: {
      status: "passed",
      level: "tool_verified",
      revision: "staged:def",
      verifierVersion: "code-acceptance-1",
      tier: "os",
      exit: "0",
      report: "reports/junit.xml",
      discovered: 4,
      passed: 4,
      failed: 0,
      errored: 0,
      skipped: 0,
      checks: [],
      hasModelCheck: false,
    },
    progress: {
      subtasks: 1,
      attempts: 1,
      turns: 3,
      toolOperations: 5,
      repairs: 0,
      takeovers: 0,
      scopeExpansions: 0,
      tier: "os",
      delivery: "workspace_updated",
      deliveredRevision: "staged:def",
      empty: false,
    },
    approvals: [approvalView()],
    pendingApproval: approvalView(),
    ...over,
  }
}

function interrupt(over: Partial<ExecutionRunInterrupt> = {}): ExecutionRunInterrupt {
  return {
    id: "approval-1",
    runId: "run-1",
    type: "fusion_approval",
    status: "pending",
    title: "Router + Fusion approval",
    requestDigest: "d".repeat(64),
    expiresAt: Date.now() + 60_000,
    createdAt: Date.now(),
    ...over,
  }
}

const ready = (over: Partial<DelegateReview> = {}): DelegateReviewState => ({
  state: "ready",
  review: review(over),
})

beforeEach(() => jest.clearAllMocks())

describe("isFusionApprovalInterrupt", () => {
  it("recognises only the delegate approval interrupt", () => {
    expect(isFusionApprovalInterrupt(interrupt())).toBe(true)
    expect(isFusionApprovalInterrupt({ type: "bot_approval" })).toBe(false)
    expect(isFusionApprovalInterrupt(null)).toBe(false)
  })
})

describe("DelegateReviewPane", () => {
  it("[ACC:OFF-01] renders nothing while Router + Fusion is off", async () => {
    const { container } = render(
      <DelegateReviewPane runId="run-1" load={async () => ({ state: "off" })} />
    )
    await waitFor(() => expect(container).toBeEmptyDOMElement())
  })

  it("renders nothing for a run that is not a delegation", async () => {
    const { container } = render(
      <DelegateReviewPane runId="run-1" load={async () => ({ state: "not-delegate" })} />
    )
    await waitFor(() => expect(container).toBeEmptyDOMElement())
  })

  it("says the record could not be read rather than showing an empty review", async () => {
    render(
      <DelegateReviewPane
        runId="run-1"
        load={async () => ({ state: "unavailable", reason: "the vault is locked" })}
      />
    )
    expect(await screen.findByTestId("delegate-review-unavailable")).toHaveTextContent(
      "the vault is locked"
    )
  })

  it("shows the patch, the checks and the delegation counts of a delegate run", async () => {
    render(<DelegateReviewPane runId="run-1" load={async () => ready()} />)
    expect(await screen.findByTestId("delegate-review")).toBeInTheDocument()
    expect(screen.getByTestId("delegate-checks")).toHaveTextContent("OS sandbox")
    expect(screen.getByTestId("delegate-patch")).toHaveTextContent("git:abc")
    expect(screen.getByTestId("delegate-run-details")).toHaveTextContent("Worker turns")
  })

  it("[ACC:API-08] approves through the control plane, labelled by what is being approved", async () => {
    const user = userEvent.setup()
    const onDecide = jest.fn()
    render(
      <DelegateReviewPane
        runId="run-1"
        interrupt={interrupt()}
        onDecide={onDecide}
        load={async () => ready()}
      />
    )
    const approval = await screen.findByTestId("delegate-review-approval")
    expect(approval).toHaveTextContent("Workspace apply")
    expect(approval).toHaveTextContent("d".repeat(64))
    await user.click(screen.getByTestId("delegate-review-approve"))
    expect(onDecide).toHaveBeenCalledWith("approve")
    await user.click(screen.getByTestId("delegate-review-deny"))
    expect(onDecide).toHaveBeenCalledWith("deny")
  })

  it("[ACC:DEL-07] labels a scope expansion as what it is", async () => {
    render(
      <DelegateReviewPane
        runId="run-1"
        interrupt={interrupt()}
        onDecide={jest.fn()}
        load={async () =>
          ready({
            pendingApproval: approvalView({ kind: "scope_expansion" }),
            approvals: [approvalView({ kind: "scope_expansion" })],
          })
        }
      />
    )
    const approval = await screen.findByTestId("delegate-review-approval")
    expect(approval).toHaveTextContent("Scope expansion")
    expect(approval).toHaveTextContent("outside the paths its subtask allowed")
    expect(screen.getByTestId("delegate-review-approve")).toHaveTextContent("Approve")
  })

  it("[ACC:API-08] offers no decision when the interrupt names another request", async () => {
    render(
      <DelegateReviewPane
        runId="run-1"
        interrupt={interrupt({ id: "approval-other" })}
        onDecide={jest.fn()}
        load={async () => ready()}
      />
    )
    expect(await screen.findByTestId("delegate-review-mismatch")).toBeInTheDocument()
    expect(screen.queryByTestId("delegate-review-approve")).not.toBeInTheDocument()
  })

  it("offers no decision when the run is not parked on one", async () => {
    render(<DelegateReviewPane runId="run-1" onDecide={jest.fn()} load={async () => ready()} />)
    expect(await screen.findByTestId("delegate-review")).toBeInTheDocument()
    expect(screen.queryByTestId("delegate-review-approve")).not.toBeInTheDocument()
  })

  it("explains that a patch-only run is not applied from here", async () => {
    render(
      <DelegateReviewPane
        runId="run-1"
        load={async () =>
          ready({
            pendingApproval: null,
            approvals: [approvalView({ status: "approved", decidedAt: 30 })],
            patch: { ...review().patch!, delivery: "patch_only" },
          })
        }
      />
    )
    expect(await screen.findByTestId("delegate-review-apply-note")).toHaveTextContent(
      "This run delivered a patch only"
    )
    expect(screen.getByTestId("delegate-review-history")).toHaveTextContent("Approved")
    expect(screen.getByTestId("delegate-review-history")).toHaveTextContent(
      new Date(30).toISOString()
    )
    expect(screen.getByTestId("delegate-review-history")).not.toHaveTextContent("Overdue")
  })

  it("downloads the patch document through the app's save dialog", async () => {
    const user = userEvent.setup()
    const save = jest.fn().mockResolvedValue(true)
    render(<DelegateReviewPane runId="run-1" load={async () => ready()} save={save} />)
    await user.click(await screen.findByRole("button", { name: "Download patch" }))
    await waitFor(() =>
      expect(save).toHaveBeenCalledWith(
        expect.objectContaining({
          defaultName: "delegate-patch-run-1.json",
          content: '{"format":"cognia-delegate-patch-1"}',
        })
      )
    )
    expect(mockToast.success).toHaveBeenCalledWith("Patch saved.")
  })

  it("reports a failed download instead of claiming the patch was saved", async () => {
    const user = userEvent.setup()
    const save = jest.fn().mockRejectedValue(new Error("no disk"))
    render(<DelegateReviewPane runId="run-1" load={async () => ready()} save={save} />)
    await user.click(await screen.findByRole("button", { name: "Download patch" }))
    await waitFor(() =>
      expect(mockToast.error).toHaveBeenCalledWith("The patch could not be saved.")
    )
    expect(mockToast.success).not.toHaveBeenCalled()
  })

  it("re-reads the record when the run settles the decision it was parked on", async () => {
    const load = jest.fn().mockResolvedValue(ready())
    const { rerender } = render(
      <DelegateReviewPane runId="run-1" interrupt={interrupt()} onDecide={jest.fn()} load={load} />
    )
    await screen.findByTestId("delegate-review-approval")
    expect(load).toHaveBeenCalledTimes(1)
    rerender(
      <DelegateReviewPane
        runId="run-1"
        interrupt={interrupt({ status: "approved" })}
        onDecide={jest.fn()}
        load={load}
      />
    )
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2))
  })
})

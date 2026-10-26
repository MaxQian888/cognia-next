/** @jest-environment jsdom */
import { render, screen } from "@testing-library/react"
import {
  makeComponents,
  makeEvidence,
  makeRun,
  makeSnapshot,
  makeStep,
} from "@/lib/harness/test-fixtures"
import { HarnessStepDetail } from "./harness-step-detail"

jest.mock("./harness-snapshot-diff", () => ({
  HarnessSnapshotDiff: ({
    before,
    after,
  }: {
    before: { memory: string }
    after: { memory: string }
  }) => <div data-testid="diff-probe">{`${before.memory} -> ${after.memory}`}</div>,
}))

const base = makeSnapshot()
const produced = makeSnapshot({
  id: "snap-dom1",
  components: makeComponents({ memory: "CSV may use ;" }),
})
const snapshots = new Map([
  [base.id, base],
  [produced.id, produced],
])
const run = makeRun({ baseSnapshotId: base.id })

describe("HarnessStepDetail", () => {
  it("shows a rollout's evidence and where reused evidence came from", () => {
    render(
      <HarnessStepDetail
        run={run}
        step={makeStep("roll:inv1", {
          evidence: makeEvidence(),
          cacheHitOf: "run-0:base1",
          costUsd: 0.25,
          startedAt: 0,
          endedAt: 2000,
        })}
        snapshots={snapshots}
      />
    )
    expect(screen.getByText("Rollout of General edit 1")).toBeInTheDocument()
    expect(screen.getByText(/1 attempts · 120 tokens · \$0.25 · 2.00s/)).toBeInTheDocument()
    expect(
      screen.getByText(/reused from an identical earlier rollout \(base1\)/)
    ).toBeInTheDocument()
    expect(screen.getByTestId("harness-evidence")).toBeInTheDocument()
  })

  it("shows an editor stage's notes and its changes from the base", () => {
    render(
      <HarnessStepDetail
        run={run}
        step={makeStep("dom1", {
          kind: "propose",
          dim: "DOM",
          snapshotId: produced.id,
          notes: "Added a separator note.",
        })}
        snapshots={snapshots}
      />
    )
    expect(screen.getByText("DOM")).toBeInTheDocument()
    expect(screen.getByText("Added a separator note.")).toBeInTheDocument()
    expect(screen.getByTestId("diff-probe")).toHaveTextContent("-> CSV may use ;")
  })

  it("says when a stage's harness is gone, or it fell back, and renders failures", () => {
    render(
      <HarnessStepDetail
        run={run}
        step={makeStep("inv1", {
          kind: "propose",
          status: "failed",
          snapshotId: "gone",
          fellBack: true,
          error: "proposal invalid twice",
        })}
        snapshots={snapshots}
      />
    )
    expect(screen.getByText("proposal invalid twice")).toBeInTheDocument()
    expect(screen.getByText(/kept its input/)).toBeInTheDocument()
    expect(screen.getByText("This harness version is no longer stored.")).toBeInTheDocument()
  })

  it("renders the selection and reflection records", () => {
    const { rerender } = render(
      <HarnessStepDetail
        run={makeRun({
          decision: { outcome: "keep-base", reason: "nothing beat it", requiresApproval: false },
        })}
        step={makeStep("select", {
          kind: "select",
          selection: { method: "deterministic", regressed: [], dominant: [], unchanged: [] },
        })}
        snapshots={snapshots}
      />
    )
    expect(screen.getByTestId("harness-decision")).toHaveTextContent("nothing beat it")
    expect(screen.getByTestId("harness-selection")).toBeInTheDocument()
    rerender(
      <HarnessStepDetail
        run={run}
        step={makeStep("reflect", { kind: "reflect", reflection: { edits: [], retrieved: [] } })}
        snapshots={snapshots}
      />
    )
    expect(screen.getByTestId("harness-reflection")).toBeInTheDocument()
  })
})

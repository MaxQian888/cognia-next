/** @jest-environment jsdom */
import { selectOption } from "@/lib/testing/select-option"
import { render, screen } from "@testing-library/react"
import { makeComponents, makeEvidence, makeSnapshot, makeStep } from "@/lib/harness/test-fixtures"
import { HarnessCandidateCompare } from "./harness-candidate-compare"

jest.mock("./harness-snapshot-diff", () => ({
  HarnessSnapshotDiff: ({
    before,
    after,
  }: {
    before: { memory: string }
    after: { memory: string }
  }) => <div data-testid="diff-probe">{`${before.memory} -> ${after.memory}`}</div>,
}))

const base = makeSnapshot({ components: makeComponents({ memory: "BASE" }) })
const inv = makeSnapshot({ id: "s-inv", components: makeComponents({ memory: "INV" }) })
const agg = makeSnapshot({ id: "s-agg", components: makeComponents({ memory: "AGG" }) })
const snapshots = new Map([base, inv, agg].map((s) => [s.id, s]))
const steps = [
  makeStep("base1", { evidence: makeEvidence({ delivered: false }) }),
  makeStep("inv1", { kind: "propose", snapshotId: inv.id }),
  makeStep("roll:inv1", { evidence: makeEvidence() }),
  makeStep("agg1", { kind: "compose", snapshotId: agg.id }),
]

describe("HarnessCandidateCompare", () => {
  it("opens on the base against the chosen harness, and compares any pair", async () => {
    render(
      <HarnessCandidateCompare
        run={{
          baseSnapshotId: base.id,
          decision: { outcome: "adopt", reason: "", chosenLabel: "inv1", requiresApproval: false },
        }}
        steps={steps}
        snapshots={snapshots}
      />
    )
    expect(screen.getByTestId("diff-probe")).toHaveTextContent("BASE -> INV")
    expect(screen.getByTestId("harness-compare-summary-base")).toHaveTextContent("No")
    expect(screen.getByTestId("harness-compare-summary-inv1")).toHaveTextContent("1 of 1 passed")
    await selectOption(screen.getByLabelText("Right harness"), "agg1")
    expect(screen.getByTestId("diff-probe")).toHaveTextContent("BASE -> AGG")
    expect(screen.getByText("Not rolled out yet.")).toBeInTheDocument()
    await selectOption(screen.getByLabelText("Left harness"), "inv1")
    expect(screen.getByTestId("diff-probe")).toHaveTextContent("INV -> AGG")
  })

  it("waits for candidates", () => {
    render(
      <HarnessCandidateCompare run={{ baseSnapshotId: base.id }} steps={[]} snapshots={snapshots} />
    )
    expect(screen.getByText("No candidate harness to compare yet.")).toBeInTheDocument()
  })
})

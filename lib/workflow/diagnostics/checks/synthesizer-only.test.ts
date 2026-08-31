import { checkSynthesizerOnly } from "./synthesizer-only"
import type { VisualWorkflow } from "@/types/workflow/visual"

function wf(kinds: string[]): VisualWorkflow {
  return {
    id: "wf_1",
    schemaVersion: 1,
    name: "w",
    nodes: kinds.map((kind, i) => ({
      id: `n${i}`,
      type: kind,
      typeVersion: 1,
      position: { x: 0, y: 0 },
      data: { label: kind, params: {} },
    })),
    edges: [],
    settings: {},
    createdAt: 0,
    updatedAt: 0,
  } as unknown as VisualWorkflow
}

describe("checkSynthesizerOnly", () => {
  it("says nothing about ordinary nodes", () => {
    expect(checkSynthesizerOnly(wf(["trigger.manual", "ai.prompt", "action.agent.turn"]))).toEqual(
      []
    )
  })

  it("flags a hand-placed pattern node at edit time", () => {
    // Before this, the only signal was the executor throwing
    // `no TeamRunContext registered for runId=…` mid-run, which reads as a
    // host bug rather than as "this node is not yours to place".
    const found = checkSynthesizerOnly(wf(["pattern.judge-panel"]))
    expect(found).toHaveLength(1)
    expect(found[0]!.code).toBe("synthesizerOnly")
    expect(found[0]!.severity).toBe("error")
    expect(found[0]!.nodeId).toBe("n0")
    expect(found[0]!.messageParams).toEqual({ lifecycle: "team" })
  })

  it("flags every team node whose executor needs the run context", () => {
    const kinds = [
      "action.team.task.dispatch",
      "action.team.task.review",
      "action.team.reconcile",
      "pattern.multi-modal-sweep",
      "pattern.loop-until-dry",
      "pattern.adversarial-verify",
      "pattern.judge-panel",
      "pattern.completeness-critic",
      "pattern.synthesize",
    ]
    expect(checkSynthesizerOnly(wf(kinds))).toHaveLength(kinds.length)
  })

  it("leaves plan step dispatch alone, because it bootstraps its own context", () => {
    expect(checkSynthesizerOnly(wf(["action.plan.step.dispatch"]))).toEqual([])
  })
})

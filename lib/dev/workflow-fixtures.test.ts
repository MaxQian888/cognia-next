import {
  buildWorkflowFixture,
  SEEDED_WORKFLOW_KINDS,
  type SeededWorkflowKind,
} from "./workflow-fixtures"
import { paramsSchemaFor } from "@/lib/workflow/nodes/params-schemas"
import { WORKFLOW_NODE_KINDS, type WorkflowNodeKind } from "@/types/workflow/visual"

describe("workflow-fixtures", () => {
  it("registers a factory for every advertised kind", () => {
    for (const kind of SEEDED_WORKFLOW_KINDS) {
      const draft = buildWorkflowFixture(kind)
      expect(draft.name).toBeTruthy()
      expect(Array.isArray(draft.nodes)).toBe(true)
      expect(draft.nodes!.length).toBeGreaterThan(0)
    }
  })

  it("throws for unknown kinds", () => {
    expect(() => buildWorkflowFixture("not-a-real-kind" as SeededWorkflowKind)).toThrow(
      /Unknown seeded workflow kind/
    )
  })

  it("each fixture's nodes use known workflow node kinds", () => {
    const valid = new Set(WORKFLOW_NODE_KINDS)
    for (const kind of SEEDED_WORKFLOW_KINDS) {
      const draft = buildWorkflowFixture(kind)
      for (const node of draft.nodes ?? []) {
        expect(valid.has(node.type as never)).toBe(true)
      }
    }
  })

  it("each fixture's edges reference existing node ids", () => {
    for (const kind of SEEDED_WORKFLOW_KINDS) {
      const draft = buildWorkflowFixture(kind)
      const ids = new Set((draft.nodes ?? []).map((n) => n.id))
      for (const edge of draft.edges ?? []) {
        expect(ids.has(edge.source)).toBe(true)
        expect(ids.has(edge.target)).toBe(true)
      }
    }
  })

  it("each fixture's node params satisfy the registered node schema", () => {
    const failures: Array<{
      fixture: SeededWorkflowKind
      node: string
      type: string
      issues: unknown[]
    }> = []
    for (const kind of SEEDED_WORKFLOW_KINDS) {
      const draft = buildWorkflowFixture(kind)
      for (const node of draft.nodes ?? []) {
        const params =
          node.data?.params ??
          (node as unknown as { params?: Record<string, unknown> }).params ??
          {}
        const result = paramsSchemaFor(node.type as WorkflowNodeKind).safeParse(params)
        if (!result.success) {
          failures.push({
            fixture: kind,
            node: node.id,
            type: node.type,
            issues: result.error.issues,
          })
        }
      }
    }
    expect(failures).toEqual([])
  })

  it("covers every action.* / ai.* / flow.* / data.* / io.* / annotation.* / trigger.* kind via at least one fixture", () => {
    const seen = new Set<string>()
    for (const kind of SEEDED_WORKFLOW_KINDS) {
      for (const node of buildWorkflowFixture(kind).nodes ?? []) {
        seen.add(node.type)
      }
    }
    // Every advertised kind in the visual taxonomy should appear in at least
    // one fixture. The only exclusions are synthesizer-emitted-only kinds that
    // are never placed by users in the editor and carry no palette/catalog
    // entry (see `types/workflow/visual.ts` and `lib/workflow/nodes/catalog.ts`).
    // A standalone seed fixture would be meaningless for these nodes because
    // their params are shaped by the synthesizer at run time and covered by the
    // relevant runtime specs:
    //   • `action.plan.step.dispatch` — emitted one-per-PlanStep by the Unified
    //     Plan Execution Hub (ADR-0045); covered by the plan-runtime specs.
    //   • the six `pattern.*` kinds — emitted by `synthesize-ultracode.ts`
    //     (ADR-0022 addendum); each is covered by its co-located executor spec
    //     under `lib/ai/agent/team/patterns/`.)
    const skip = new Set<string>([
      "action.plan.step.dispatch",
      "pattern.multi-modal-sweep",
      "pattern.loop-until-dry",
      "pattern.adversarial-verify",
      "pattern.judge-panel",
      "pattern.completeness-critic",
      "pattern.synthesize",
    ])
    const missing = WORKFLOW_NODE_KINDS.filter((k) => !seen.has(k) && !skip.has(k))
    expect(missing).toEqual([])
  })
})

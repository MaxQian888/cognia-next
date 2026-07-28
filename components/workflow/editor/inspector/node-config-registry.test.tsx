/**
 * @jest-environment jsdom
 */
import { WORKFLOW_NODE_KINDS, type WorkflowNodeKind } from "@/types/workflow/visual"
import {
  getNodeConfigComponent,
  getNodeConfigComponentForEntry,
  hasDedicatedConfig,
} from "./node-config-registry"

// Kinds that intentionally fall back to the raw-JSON editor (no dedicated form).
// Keep this list tight — adding a kind here must be a deliberate decision.
const INTENTIONAL_FALLBACKS = new Set<WorkflowNodeKind>([
  // The kinds below are synthesizer-emitted only — they carry NO palette /
  // catalog entry (see `lib/workflow/nodes/catalog.ts` and the "not placed by
  // users in the editor" comments in `types/workflow/visual.ts`), so the
  // inspector never opens a dedicated form for them. They are built by the
  // synthesizer at run time and validated by their executors:
  //   • `action.plan.step.dispatch` — one-per-PlanStep (Unified Plan Execution
  //     Hub, ADR-0045).
  //   • the six `pattern.*` kinds — ultracode orchestration nodes emitted by
  //     `synthesize-ultracode.ts` (ADR-0022 addendum).
  //   • `action.team.task.review` — one-per-task blocking lead review, emitted
  //     by `synthesize-workflow.ts` when `taskReview.enabled` (ADR-0071).
  "action.plan.step.dispatch",
  "action.team.task.review",
  "pattern.multi-modal-sweep",
  "pattern.loop-until-dry",
  "pattern.adversarial-verify",
  "pattern.judge-panel",
  "pattern.completeness-critic",
  "pattern.synthesize",
])

const DESKTOP_KINDS: WorkflowNodeKind[] = [
  "action.desktop.screenshot",
  "action.desktop.findElement",
  "action.desktop.readTree",
  "action.desktop.click",
  "action.desktop.type",
  "action.desktop.keys",
  "action.desktop.invokePattern",
  "action.desktop.windowFocus",
  "action.desktop.windowClose",
  "action.desktop.windowResize",
  "action.desktop.wait",
]

const NEWLY_WIRED: WorkflowNodeKind[] = [
  "trigger.integration.event",
  "trigger.team",
  "action.team.task.dispatch",
  "trigger.desktop.event",
  "trigger.pet.event",
  "action.pet.interact",
  "ai.council",
  "ai.browserModel",
  "action.plan.create",
  "action.plan.get",
  "action.plan.list",
  "action.plan.events",
  "action.plan.updateDraft",
  "action.plan.approve",
  "action.plan.reject",
  "action.plan.refine",
  "action.plan.pause",
  "action.plan.resume",
  "action.plan.cancel",
  "action.plan.delete",
  "action.plan.run",
  "action.plan.setStepStatus",
  "action.scheduler.task.create",
  "action.scheduler.task.get",
  "action.scheduler.task.list",
  "action.scheduler.task.update",
  "action.scheduler.task.pause",
  "action.scheduler.task.resume",
  "action.scheduler.task.delete",
  "action.scheduler.task.runNow",
  "action.scheduler.task.executions",
  "action.scheduler.task.backfill",
  "action.scheduler.task.export",
  "action.scheduler.task.import",
  "action.scheduler.status",
  "action.scheduler.statistics",
  "action.scheduler.upcoming",
  "action.scheduler.executions.recent",
  "action.scheduler.execution.get",
  "action.scheduler.event.trigger",
  ...DESKTOP_KINDS,
]

describe("node-config-registry", () => {
  it("resolves a dedicated (non-fallback) config for every newly-wired kind", () => {
    for (const kind of NEWLY_WIRED) {
      expect(hasDedicatedConfig(kind)).toBe(true)
    }
  })

  it("has a dedicated config for every known kind except the intentional fallbacks", () => {
    const missing = WORKFLOW_NODE_KINDS.filter(
      (kind) => !hasDedicatedConfig(kind) && !INTENTIONAL_FALLBACKS.has(kind)
    )
    expect(missing).toEqual([])
  })

  it("returns a component for every kind (fallback never throws)", () => {
    for (const kind of WORKFLOW_NODE_KINDS) {
      expect(typeof getNodeConfigComponent(kind)).toBe("function")
    }
  })

  it("prefers a paramsSchema-driven SchemaForm for plugin kinds without a built-in", () => {
    const builtIn = getNodeConfigComponentForEntry({
      kind: "myplugin.action.fetch" as WorkflowNodeKind,
      paramsSchema: { type: "object", properties: { url: { type: "string" } } },
    })
    expect(typeof builtIn).toBe("function")
    expect(builtIn.displayName).toContain("SchemaFormFor")
  })
})

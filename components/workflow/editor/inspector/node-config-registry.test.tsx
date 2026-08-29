/**
 * @jest-environment jsdom
 */
import { WORKFLOW_NODE_KINDS, type WorkflowNodeKind } from "@/types/workflow/visual"
import { nodeCatalogEntry } from "@/lib/workflow/nodes/catalog"
import {
  getNodeConfigComponent,
  getNodeConfigComponentForEntry,
  hasDedicatedConfig,
  hasDedicatedConfigForEntry,
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
  "action.desktop.listApps",
  "action.desktop.getAppState",
  "action.desktop.queryElements",
  "action.desktop.expandElement",
  "action.desktop.performAction",
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

  it("has a structured config for every known kind except the intentional fallbacks", () => {
    // `hasDedicatedConfigForEntry`, not `hasDedicatedConfig`: what the user
    // actually gets is what `InspectorPanel` resolves, and that consults the
    // catalog entry's `paramsSchema` before falling back to raw JSON. The
    // eight `knowledge.*` kinds are palette-visible and schema-driven — they
    // have no REGISTRY row on purpose, and the kind-only predicate reported
    // them as unconfigurable when the editor renders a real form for them.
    const missing = WORKFLOW_NODE_KINDS.filter(
      (kind) =>
        !hasDedicatedConfigForEntry(nodeCatalogEntry(kind)) && !INTENTIONAL_FALLBACKS.has(kind)
    )
    expect(missing).toEqual([])
  })

  it("keeps the fallback list honest — no listed kind secretly has a form", () => {
    // Guards the allowlist above from silently absorbing a kind that grew a
    // form later: an entry that no longer needs the exemption must be removed.
    const stale = [...INTENTIONAL_FALLBACKS].filter((kind) =>
      hasDedicatedConfigForEntry(nodeCatalogEntry(kind))
    )
    expect(stale).toEqual([])
  })

  it("still resolves the built-in registry for kinds that ship a form", () => {
    // `hasDedicatedConfig` is the narrower, REGISTRY-only predicate; keep it
    // covered so the two never drift into disagreeing about a built-in.
    for (const kind of NEWLY_WIRED) {
      expect(hasDedicatedConfig(kind)).toBe(hasDedicatedConfigForEntry(nodeCatalogEntry(kind)))
    }
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

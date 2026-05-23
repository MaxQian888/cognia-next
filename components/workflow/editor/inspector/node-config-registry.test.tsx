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
  // GitHub actions ship their own forms via the github-delivery plugin overlay,
  // but the trigger + 13 actions ARE wired below, so none remain here.
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
  "trigger.team",
  "action.team.task.dispatch",
  "trigger.desktop.event",
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

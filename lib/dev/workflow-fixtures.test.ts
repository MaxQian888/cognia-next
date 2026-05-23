import {
  buildWorkflowFixture,
  SEEDED_WORKFLOW_KINDS,
  type SeededWorkflowKind,
} from "./workflow-fixtures"
import { WORKFLOW_NODE_KINDS } from "@/types/workflow/visual"

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

  it("covers every action.* / ai.* / flow.* / data.* / io.* / annotation.* / trigger.* kind via at least one fixture", () => {
    const seen = new Set<string>()
    for (const kind of SEEDED_WORKFLOW_KINDS) {
      for (const node of buildWorkflowFixture(kind).nodes ?? []) {
        seen.add(node.type)
      }
    }
    // Every advertised kind in the visual taxonomy should appear in at least
    // one fixture. (Exceptions: `trigger.desktop.event` is registered for the
    // sidebar but has no first-class seed yet — it's covered by the desktop
    // family specs through editor-level interaction only. The two `*.team.*`
    // kinds were added with the agent-teams workflow integration; they are
    // exercised through the agent-team-runtime tests rather than fixtures.
    // `action.system.terminal` is exercised via terminal-dock E2E plus the
    // `lib/workflow/nodes/terminal.test.ts` executor spec; no seed fixture
    // yet because the integrated terminal needs a Tauri host.)
    const skip = new Set<string>([
      "trigger.desktop.event",
      "trigger.team",
      "action.team.task.dispatch",
      "action.system.terminal",
    ])
    const missing = WORKFLOW_NODE_KINDS.filter((k) => !seen.has(k) && !skip.has(k))
    expect(missing).toEqual([])
  })
})

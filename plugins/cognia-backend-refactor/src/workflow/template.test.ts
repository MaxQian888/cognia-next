/** @cognia-host-integration-test */
import { REFACTOR_PIPELINE_TEMPLATE } from "./template"
import { validateWorkflowTemplateRequires } from "@/lib/plugin/registries/workflow-template-registry"
import {
  addPluginCatalogEntry,
  removePluginCatalogEntry,
  type NodeCatalogEntry,
} from "@/lib/workflow/nodes/catalog"
import { projectPluginWorkflowTemplate } from "@/lib/workflow/templates/project-plugin-workflow-template"
import { validateGraphIntegrity } from "@/lib/workflow/definition/validate"
import { nodeKind, PLUGIN_ID } from "../ids"
import {
  APPROVE_VERDICT_PATTERN,
  CLEAN_TREE_CHECK,
  COMMIT_COMMAND,
  REQUEST_CHANGES_VERDICT,
  REVIEW_DIFF_COMMAND,
} from "./template"
import { READ_TOOLS, REFACTOR_ROLE_PACK } from "../characters/pack"
import { evaluateConditionGroup } from "@/lib/workflow/runtime/conditions"
import { outputHandlesFor } from "@/lib/workflow/editor/node-handles"

const AGENT_TURN = nodeKind("agent.turn")
const PIPELINE_STOP = nodeKind("pipeline.stop")

function edgesFrom(source: string) {
  return REFACTOR_PIPELINE_TEMPLATE.edges.filter((e) => e.source === source)
}
function edgesTo(target: string) {
  return REFACTOR_PIPELINE_TEMPLATE.edges.filter((e) => e.target === target)
}

describe("REFACTOR_PIPELINE_TEMPLATE shape", () => {
  const nodeIds = new Set(REFACTOR_PIPELINE_TEMPLATE.nodes.map((n) => n.id))

  it("is an advanced automation template", () => {
    expect(REFACTOR_PIPELINE_TEMPLATE.category).toBe("automation")
    expect(REFACTOR_PIPELINE_TEMPLATE.complexity).toBe("advanced")
  })

  it("references only declared node ids on every edge endpoint", () => {
    for (const e of REFACTOR_PIPELINE_TEMPLATE.edges) {
      expect(nodeIds.has(e.source)).toBe(true)
      expect(nodeIds.has(e.target)).toBe(true)
    }
  })

  it("branches gate1 into success → ok1 and failure → fix1", () => {
    const fromGate1 = edgesFrom("gate1")
    expect(fromGate1.find((e) => e.sourceHandle === "success")?.target).toBe("ok1")
    expect(fromGate1.find((e) => e.sourceHandle === "failure")?.target).toBe("fix1")
  })

  it("runs one bounded fix attempt that re-verifies via gate2", () => {
    expect(edgesFrom("fix1").map((e) => e.target)).toEqual(["gate2"])
    const fromGate2 = edgesFrom("gate2")
    expect(fromGate2.find((e) => e.sourceHandle === "success")?.target).toBe("ok2")
    expect(fromGate2.find((e) => e.sourceHandle === "failure")?.target).toBe("stopGate")
  })

  it("converges both verified paths on the shared tail through okN passthroughs", () => {
    // test must NOT be a direct branch target (a gate failure would skip it);
    // it converges via the ok1/ok2 flow.set passthroughs.
    expect(
      edgesTo("test")
        .map((e) => e.source)
        .sort()
    ).toEqual(["ok1", "ok2"])
    const okKinds = REFACTOR_PIPELINE_TEMPLATE.nodes
      .filter((n) => n.id === "ok1" || n.id === "ok2")
      .map((n) => n.type)
    expect(okKinds).toEqual(["flow.set", "flow.set"])
  })

  it("ends every give-up path on a stop node that FAILS the run", () => {
    // The old give-up leaf was a flow.set, which completes — so a run that
    // could not build was recorded as a success.
    const stops = REFACTOR_PIPELINE_TEMPLATE.nodes.filter((n) => n.type === PIPELINE_STOP)
    expect(stops.map((n) => n.id).sort()).toEqual(
      ["stopChanges", "stopDirty", "stopGate", "stopRejected"].sort()
    )
    for (const n of stops) {
      expect(edgesFrom(n.id)).toHaveLength(0)
      expect(String((n.data.params as { reason?: string }).reason).length).toBeGreaterThan(20)
    }
    expect(REFACTOR_PIPELINE_TEMPLATE.nodes.some((n) => n.id === "failnote")).toBe(false)
    expect(REFACTOR_PIPELINE_TEMPLATE.edges.some((e) => e.target === "trigger")).toBe(false)
  })

  it("refuses to start on a dirty working tree", () => {
    expect(edgesFrom("trigger").map((e) => e.target)).toEqual(["clean"])
    const clean = REFACTOR_PIPELINE_TEMPLATE.nodes.find((n) => n.id === "clean")
    expect(clean?.data.params).toMatchObject({ command: CLEAN_TREE_CHECK, onFailure: "branch" })
    const fromClean = edgesFrom("clean")
    expect(fromClean.find((e) => e.sourceHandle === "success")?.target).toBe("analyze")
    expect(fromClean.find((e) => e.sourceHandle === "failure")?.target).toBe("stopDirty")
  })

  it("hands the read-only reviewer the diff, since it holds no Bash to run git", () => {
    expect(edgesFrom("cover").map((e) => e.target)).toEqual(["diff"])
    expect(edgesFrom("diff").map((e) => e.target)).toEqual(["review"])
    const diff = REFACTOR_PIPELINE_TEMPLATE.nodes.find((n) => n.id === "diff")
    expect(diff?.data.params).toMatchObject({ command: REVIEW_DIFF_COMMAND, onFailure: "throw" })
    const review = REFACTOR_PIPELINE_TEMPLATE.nodes.find((n) => n.id === "review")
    expect(String(review?.data.params?.prompt)).toContain("{{ $node['diff'].output }}")
    for (const role of ["analyst", "architect", "reviewer"]) {
      const character = REFACTOR_ROLE_PACK.characters.find((c) => c.localId === role)
      expect(character?.allowedTools).toEqual(READ_TOOLS)
    }
    expect(READ_TOOLS).not.toContain("Bash")
  })

  it("only reaches docs + commit when the reviewer's verdict is APPROVE", () => {
    expect(edgesFrom("review").map((e) => e.target)).toEqual(["verdict"])
    const verdict = REFACTOR_PIPELINE_TEMPLATE.nodes.find((n) => n.id === "verdict")!
    expect(verdict.type).toBe("flow.branch")
    expect(verdict.typeVersion).toBe(2)
    const fromVerdict = edgesFrom("verdict")
    expect(fromVerdict.find((e) => e.sourceHandle === "true")?.target).toBe("doc")
    expect(fromVerdict.find((e) => e.sourceHandle === "false")?.target).toBe("stopChanges")
    // The handles the edges use are the ones the editor/orchestrator emit.
    expect(
      outputHandlesFor({ kind: "flow.branch", typeVersion: 2, params: {} })?.map((h) => h.id)
    ).toEqual(["true", "false"])
  })

  it("evaluates the verdict condition fail-closed", () => {
    const verdict = REFACTOR_PIPELINE_TEMPLATE.nodes.find((n) => n.id === "verdict")!
    const group = (
      verdict.data.params as { conditions: Parameters<typeof evaluateConditionGroup>[0] }
    ).conditions
    const decide = (text: string) =>
      evaluateConditionGroup({
        ...group,
        conditions: group.conditions.map((c) => ({ ...c, left: text })),
      })
    expect(decide("Looks good.\nVERDICT: APPROVE")).toBe(true)
    expect(decide(`Blocking: nil deref.\n${REQUEST_CHANGES_VERDICT}`)).toBe(false)
    expect(decide("I would approve this.")).toBe(false)
    expect(decide("VERDICT: APPROVE\nVERDICT: REQUEST CHANGES")).toBe(false)
    expect(decide("verdict: approve")).toBe(false)
    expect(new RegExp(APPROVE_VERDICT_PATTERN).test("VERDICT: APPROVED")).toBe(false)
  })

  it("puts a human approval, showing the files, between the reviewer and the commit", () => {
    expect(edgesFrom("doc").map((e) => e.target)).toEqual(["summary"])
    expect(edgesFrom("summary").map((e) => e.target)).toEqual(["approve"])
    const approve = REFACTOR_PIPELINE_TEMPLATE.nodes.find((n) => n.id === "approve")!
    expect(approve.type).toBe("action.approval.request")
    expect(String((approve.data.params as { message?: string }).message)).toContain(
      "$node['summary'].output"
    )
    expect((approve.data.params as { onTimeout?: string }).onTimeout).toBe("reject")
    const fromApprove = edgesFrom("approve")
    expect(fromApprove.find((e) => e.sourceHandle === "approved")?.target).toBe("commit")
    expect(fromApprove.find((e) => e.sourceHandle === "rejected")?.target).toBe("stopRejected")
    expect(edgesTo("commit").map((e) => e.source)).toEqual(["approve"])
  })

  it("stages only what the run changed, never `git add -A`", () => {
    const commit = REFACTOR_PIPELINE_TEMPLATE.nodes.find((n) => n.id === "commit")!
    const command = String((commit.data.params as { command?: string }).command)
    expect(command).toBe(COMMIT_COMMAND)
    expect(command).not.toMatch(/git add (-A|--all|\.)(\s|$)/)
    expect(command).toContain("git add --update")
    expect(command).toContain("--exclude-standard")
  })

  it("drives every agent step through the plugin's agent.turn node, scoped to repoPath", () => {
    const turns = REFACTOR_PIPELINE_TEMPLATE.nodes.filter((n) => n.type === AGENT_TURN)
    expect(turns.length).toBeGreaterThanOrEqual(6)
    for (const n of turns) {
      const params = n.data.params as { role?: string; cwd?: string }
      expect(params.role).toBeDefined()
      expect(params.cwd).toBe("{{ $vars.repoPath }}")
    }
  })

  it("requires both plugin node kinds it uses", () => {
    expect(REFACTOR_PIPELINE_TEMPLATE.requires?.pluginNodeKinds).toEqual([
      AGENT_TURN,
      PIPELINE_STOP,
    ])
  })

  it("projects into a graph the host validator accepts (legal DAG, no illegal cycle)", () => {
    const wf = projectPluginWorkflowTemplate({
      id: REFACTOR_PIPELINE_TEMPLATE.id,
      entry: REFACTOR_PIPELINE_TEMPLATE,
      pluginId: PLUGIN_ID,
    })
    const result = validateGraphIntegrity(wf)
    expect(result.errors).toEqual([])
  })
})

describe("REFACTOR_PIPELINE_TEMPLATE requires resolution", () => {
  const catalogEntry = {
    kind: AGENT_TURN,
    category: "plugin",
    label: "Refactor Agent Turn",
    description: "test",
    iconName: "bot",
    keywords: [],
    pluginId: PLUGIN_ID,
    paramsSchema: {},
  } as unknown as NodeCatalogEntry

  const stopEntry = {
    ...catalogEntry,
    kind: PIPELINE_STOP,
    label: "Stop pipeline (fail run)",
  } as unknown as NodeCatalogEntry

  afterEach(() => {
    removePluginCatalogEntry(AGENT_TURN)
    removePluginCatalogEntry(PIPELINE_STOP)
  })

  it("warns when the agent.turn node is not in the catalog", () => {
    removePluginCatalogEntry(AGENT_TURN)
    const result = validateWorkflowTemplateRequires(REFACTOR_PIPELINE_TEMPLATE)
    expect(result.ok).toBe(false)
    expect(result.warnings.some((w) => w.code === "missing-plugin-node")).toBe(true)
  })

  it("resolves once both plugin nodes are registered in the catalog", () => {
    addPluginCatalogEntry(catalogEntry)
    addPluginCatalogEntry(stopEntry)
    const result = validateWorkflowTemplateRequires(REFACTOR_PIPELINE_TEMPLATE)
    expect(result.warnings).toEqual([])
    expect(result.ok).toBe(true)
  })
})

describe("REFACTOR_PIPELINE_TEMPLATE upstream references", () => {
  const byId = Object.fromEntries(REFACTOR_PIPELINE_TEMPLATE.nodes.map((n) => [n.id, n]))

  // The runtime stores a node's RAW executor output at `upstream[id]`
  // (orchestrator.ts `stepOutputs.set(stepId, result.output)`; expression.ts
  // `scope.upstream[head.id]`). A `.out.` wrapper resolves to undefined, and
  // `interpolate` renders undefined as "" — so a stale `.out.` path silently
  // feeds an EMPTY prompt to a multi-minute agent turn and the run still
  // reports success. Pin the shapes each producer actually emits:
  //   agent.turn            -> { text, messageId, characterId, role, sessionId }
  //   action.system.terminal -> { exitCode, output, sessionId, command }
  it("never uses a `.out.` wrapper in any prompt expression", () => {
    for (const node of REFACTOR_PIPELINE_TEMPLATE.nodes) {
      const params = JSON.stringify(node.data?.params ?? {})
      expect(params).not.toContain(".out.")
    }
  })

  it("reads agent.turn text and terminal output off the raw upstream shape", () => {
    expect(String(byId.plan.data.params?.prompt)).toContain("$node['analyze'].text")
    expect(String(byId.refactor.data.params?.prompt)).toContain("$node['plan'].text")
    expect(String(byId.fix1.data.params?.prompt)).toContain("$node['gate1'].output")
  })
})

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

const AGENT_TURN = nodeKind("agent.turn")

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
    expect(fromGate2.find((e) => e.sourceHandle === "failure")?.target).toBe("failnote")
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

  it("ends the second failure at a dead-end leaf (no proceed, no cycle)", () => {
    expect(edgesFrom("failnote")).toHaveLength(0)
    expect(REFACTOR_PIPELINE_TEMPLATE.edges.some((e) => e.target === "trigger")).toBe(false)
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

  it("requires the agent.turn plugin node kind", () => {
    expect(REFACTOR_PIPELINE_TEMPLATE.requires?.pluginNodeKinds).toEqual([AGENT_TURN])
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

  afterEach(() => removePluginCatalogEntry(AGENT_TURN))

  it("warns when the agent.turn node is not in the catalog", () => {
    removePluginCatalogEntry(AGENT_TURN)
    const result = validateWorkflowTemplateRequires(REFACTOR_PIPELINE_TEMPLATE)
    expect(result.ok).toBe(false)
    expect(result.warnings.some((w) => w.code === "missing-plugin-node")).toBe(true)
  })

  it("resolves once the agent.turn node is registered in the catalog", () => {
    addPluginCatalogEntry(catalogEntry)
    const result = validateWorkflowTemplateRequires(REFACTOR_PIPELINE_TEMPLATE)
    expect(result.warnings).toEqual([])
    expect(result.ok).toBe(true)
  })
})

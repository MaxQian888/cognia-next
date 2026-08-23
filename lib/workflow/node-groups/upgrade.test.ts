import {
  TEMPLATE_API_VERSION,
  type WorkflowNodeGroupDefinition,
} from "@cognia/plugin-sdk/templates"
import type { RFWorkflowEdge, RFWorkflowNode } from "@/lib/workflow/editor/react-flow-converter"
import { materializeWorkflowNodeGroup } from "./materialize"
import { applyNodeGroupUpgrade, planNodeGroupUpgrade } from "./upgrade"

function definition(version: string, nodeIds = ["a", "b"]): WorkflowNodeGroupDefinition {
  return {
    apiVersion: TEMPLATE_API_VERSION,
    id: "review-chain",
    domain: "workflow",
    status: "published",
    revision: Number(version[0]),
    version,
    metadata: { name: "Review chain" },
    payload: {
      kind: "cognia.workflow/node-group/v1",
      nodes: nodeIds.map((id, index) => ({
        id,
        type: id === "b" && version === "2.0.0" ? "io.answer" : "data.transform",
        typeVersion: 1,
        position: { x: index * 260, y: 0 },
        data: { label: id.toUpperCase(), params: {} },
      })),
      edges: nodeIds.length > 1 ? [{ id: "internal", source: "a", target: "b" }] : [],
      interface: {
        inputs: [
          {
            id: "input:a:default",
            label: "input",
            nodeId: "a",
            schema: {},
            required: true,
            source: "edge",
          },
        ],
        outputs: nodeIds.includes("b")
          ? [
              {
                id: "output:b:default",
                label: "output",
                nodeId: "b",
                schema: {},
                required: false,
                source: "edge",
              },
            ]
          : [],
      },
    },
    inputs: [],
    dependencies: [],
    capabilities: [],
    compatibility: { platforms: ["desktop", "web", "mobile"] },
    provenance: { source: "user" },
    contentHash: version.padEnd(64, "0"),
    createdAt: 1,
    updatedAt: 1,
  }
}

function graph() {
  let sequence = 0
  const materialized = materializeWorkflowNodeGroup(definition("1.0.0"), { x: 100, y: 100 }, () =>
    String(++sequence)
  )
  const source: RFWorkflowNode = {
    id: "source",
    type: "workflowNode",
    position: { x: 0, y: 100 },
    data: { label: "Source", kind: "trigger.manual", typeVersion: 1, params: {} },
  }
  const sink: RFWorkflowNode = {
    id: "sink",
    type: "workflowNode",
    position: { x: 900, y: 100 },
    data: { label: "Sink", kind: "io.output", typeVersion: 1, params: {} },
  }
  const edges: RFWorkflowEdge[] = [
    ...materialized.edges,
    { id: "external-in", source: "source", target: materialized.nodeIds[0] },
    { id: "external-out", source: materialized.nodeIds[1], target: "sink" },
  ]
  return { nodes: [source, ...materialized.nodes, sink], edges, groupId: materialized.groupId }
}

describe("node group explicit upgrades", () => {
  it("plans a compatibility diff and preserves stable instance ids and boundary edges", () => {
    const current = graph()
    const target = definition("2.0.0", ["a", "b", "c"])
    const plan = planNodeGroupUpgrade(current.nodes, current.edges, current.groupId, target)

    expect(plan).toMatchObject({
      compatible: true,
      fromVersion: "1.0.0",
      toVersion: "2.0.0",
      addedNodeIds: ["c"],
      changedNodeIds: ["b"],
    })
    const upgraded = applyNodeGroupUpgrade(
      current.nodes,
      current.edges,
      current.groupId,
      target,
      () => crypto.randomUUID()
    )
    const group = upgraded.nodes.find((node) => node.id === current.groupId)!
    const instance = (group.data.params as Record<string, unknown>).nodeGroupInstance as Record<
      string,
      unknown
    >
    const sourceNodeIds = instance.sourceNodeIds as Record<string, string>
    expect(instance.version).toBe("2.0.0")
    expect(sourceNodeIds.a).toBe("n_2")
    expect(sourceNodeIds.b).toBe("n_3")
    expect(sourceNodeIds.c).toBeDefined()
    expect(upgraded.edges.find((edge) => edge.id === "external-in")?.target).toBe("n_2")
    expect(upgraded.edges.find((edge) => edge.id === "external-out")?.source).toBe("n_3")
  })

  it("blocks an upgrade that removes a node attached to an external edge", () => {
    const current = graph()
    const target = definition("2.0.0", ["a"])
    const plan = planNodeGroupUpgrade(current.nodes, current.edges, current.groupId, target)
    expect(plan.compatible).toBe(false)
    expect(plan.blockers.join(" ")).toMatch(/external-out/)
    expect(() =>
      applyNodeGroupUpgrade(current.nodes, current.edges, current.groupId, target)
    ).toThrow(/not compatible/)
  })
})

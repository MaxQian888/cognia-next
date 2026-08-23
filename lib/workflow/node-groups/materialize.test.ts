import {
  TEMPLATE_API_VERSION,
  type WorkflowNodeGroupDefinition,
} from "@cognia/plugin-sdk/templates"
import { materializeWorkflowNodeGroup, validateWorkflowNodeGroup } from "./materialize"

function definition(): WorkflowNodeGroupDefinition {
  return {
    apiVersion: TEMPLATE_API_VERSION,
    id: "demo:review",
    domain: "workflow",
    status: "published",
    revision: 1,
    version: "1.0.0",
    metadata: { name: "Review pipeline" },
    payload: {
      kind: "cognia.workflow/node-group/v1",
      nodes: [
        {
          id: "prompt",
          type: "ai.prompt",
          typeVersion: 1,
          position: { x: 100, y: 50 },
          data: { label: "Review", params: { prompt: "Review" } },
        },
        {
          id: "output",
          type: "io.output",
          typeVersion: 1,
          position: { x: 400, y: 50 },
          data: { label: "Output", params: {} },
        },
      ],
      edges: [{ id: "edge", source: "prompt", target: "output" }],
    },
    inputs: [],
    dependencies: [],
    capabilities: [],
    compatibility: { platforms: ["desktop", "web", "mobile"] },
    provenance: { source: "plugin", pluginId: "demo" },
    contentHash: "a".repeat(64),
    createdAt: 1,
    updatedAt: 1,
  }
}

describe("workflow node-group materialization", () => {
  it("rebases ids and positions inside one existing annotation.group frame", () => {
    let sequence = 0
    const result = materializeWorkflowNodeGroup(definition(), { x: 800, y: 600 }, () =>
      String(++sequence)
    )

    expect(result.groupId).toBe("n_1")
    expect(result.nodes).toHaveLength(3)
    expect(result.nodes[0]).toMatchObject({
      id: "n_1",
      type: "groupContainer",
      position: { x: 800, y: 600 },
      data: {
        kind: "annotation.group",
        typeVersion: 2,
        label: "Review pipeline",
        params: {
          nodeGroupInstance: {
            definitionId: "demo:review",
            version: "1.0.0",
            contentHash: "a".repeat(64),
            sourceNodeIds: { prompt: "n_2", output: "n_3" },
          },
        },
      },
    })
    expect(result.nodes.slice(1)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "n_2",
          parentId: "n_1",
          position: { x: 32, y: 48 },
        }),
        expect.objectContaining({
          id: "n_3",
          parentId: "n_1",
          position: { x: 332, y: 48 },
        }),
      ])
    )
    expect(result.edges).toEqual([
      expect.objectContaining({ id: "e_4", source: "n_2", target: "n_3" }),
    ])
  })

  it("rejects dangling edges, duplicate ids, parent cycles, and oversized groups", () => {
    const base = definition()
    expect(
      validateWorkflowNodeGroup({
        ...base,
        payload: {
          ...base.payload,
          edges: [{ id: "edge", source: "missing", target: "output" }],
        },
      }).issues
    ).toEqual(expect.arrayContaining([expect.objectContaining({ code: "edge.endpoint" })]))

    expect(
      validateWorkflowNodeGroup({
        ...base,
        payload: {
          ...base.payload,
          nodes: [base.payload.nodes[0], { ...base.payload.nodes[0] }],
          edges: [],
        },
      }).issues
    ).toEqual(expect.arrayContaining([expect.objectContaining({ code: "node.duplicate-id" })]))

    expect(
      validateWorkflowNodeGroup({
        ...base,
        payload: {
          ...base.payload,
          nodes: [
            {
              ...base.payload.nodes[0],
              id: "a",
              type: "annotation.group",
              typeVersion: 2,
              parentId: "b",
            },
            {
              ...base.payload.nodes[1],
              id: "b",
              type: "annotation.group",
              typeVersion: 2,
              parentId: "a",
            },
          ],
          edges: [],
        },
      }).issues
    ).toEqual(expect.arrayContaining([expect.objectContaining({ code: "node.parent-cycle" })]))

    expect(
      validateWorkflowNodeGroup({
        ...base,
        payload: {
          ...base.payload,
          nodes: [
            { ...base.payload.nodes[0], id: "parent" },
            { ...base.payload.nodes[1], id: "child", parentId: "parent" },
          ],
          edges: [],
        },
      }).issues
    ).toEqual(expect.arrayContaining([expect.objectContaining({ code: "node.parent" })]))

    expect(
      validateWorkflowNodeGroup({
        ...base,
        payload: {
          ...base.payload,
          nodes: Array.from({ length: 257 }, (_, index) => ({
            ...base.payload.nodes[0],
            id: `n-${index}`,
          })),
          edges: [],
        },
      }).issues
    ).toEqual(expect.arrayContaining([expect.objectContaining({ code: "group.too-large" })]))
  })
})

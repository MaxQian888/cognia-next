import { InMemoryTemplateRepository } from "@/lib/templates/repository"
import { TemplateCatalog } from "@/lib/templates/catalog"
import type { VisualWorkflow } from "@/types/workflow/visual"
import {
  createNodeGroupFromSelection,
  inferNodeGroupSelection,
  type CreateNodeGroupFromSelectionInput,
} from "./authoring"

function workflow(): VisualWorkflow {
  return {
    id: "wf_1",
    schemaVersion: 2,
    name: "Source",
    createdAt: 1,
    updatedAt: 1,
    settings: {
      concurrency: 1,
      errorPolicy: "stop",
      timeoutMs: 60_000,
      retryDefaults: { attempts: 1, backoff: "fixed", baseMs: 0, maxMs: 0 },
    },
    variables: { REGION: "us-east-1" },
    nodes: [
      {
        id: "outside_in",
        type: "trigger.manual",
        typeVersion: 1,
        position: { x: 0, y: 0 },
        data: { label: "Start", params: {} },
      },
      {
        id: "selected_a",
        type: "data.transform",
        typeVersion: 1,
        position: { x: 300, y: 100 },
        data: {
          label: "Transform",
          params: {
            template: "{{ $node['outside_in'].out }} / {{ $vars.REGION }}",
          },
        },
      },
      {
        id: "selected_b",
        type: "io.output",
        typeVersion: 1,
        position: { x: 600, y: 100 },
        data: { label: "Output", params: {} },
      },
      {
        id: "outside_out",
        type: "data.transform",
        typeVersion: 1,
        position: { x: 900, y: 100 },
        data: { label: "Consumer", params: {} },
      },
    ],
    edges: [
      { id: "in", source: "outside_in", sourceHandle: "out", target: "selected_a" },
      { id: "inside", source: "selected_a", target: "selected_b" },
      { id: "out", source: "selected_b", sourceHandle: "out", target: "outside_out" },
    ],
  }
}

describe("node group selection authoring", () => {
  it("infers typed edge, expression, and variable boundaries without copying outside nodes", () => {
    const inferred = inferNodeGroupSelection(workflow(), ["selected_a", "selected_b"])

    expect(inferred.nodes.map((node) => node.id)).toEqual(["selected_a", "selected_b"])
    expect(inferred.edges.map((edge) => edge.id)).toEqual(["inside"])
    expect(inferred.interface.inputs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: "edge", nodeId: "selected_a", required: true }),
        expect.objectContaining({ source: "expression", nodeId: "selected_a", required: true }),
        expect.objectContaining({
          source: "variable",
          label: "REGION",
          defaultValue: "us-east-1",
          required: false,
        }),
      ])
    )
    expect(inferred.interface.outputs).toEqual([
      expect.objectContaining({ source: "edge", nodeId: "selected_b", handleId: "out" }),
    ])
    expect(inferred.nodes[0].position).toEqual({ x: 0, y: 0 })
  })

  it("persists an immutable version with confirmed scope and registers it in the catalog", async () => {
    const repository = new InMemoryTemplateRepository()
    const catalog = new TemplateCatalog()
    const input: CreateNodeGroupFromSelectionInput = {
      workflow: workflow(),
      selectedNodeIds: ["selected_a", "selected_b"],
      id: "review-chain",
      name: "Review chain",
      description: "Reusable reviewed transform",
      version: "1.0.0",
      scope: "workspace",
      author: "Alice",
      now: 100,
    }

    const definition = await createNodeGroupFromSelection(input, { repository, catalog })

    expect(definition.status).toBe("published")
    expect(definition.version).toBe("1.0.0")
    expect(definition.payload.distribution).toEqual({ scope: "workspace" })
    expect(await repository.getRelease("review-chain", "1.0.0")).toEqual(definition)
    expect(catalog.get("review-chain", "1.0.0")).toEqual(definition)
  })

  it("rejects empty selection and credentials that cannot be safely packaged", () => {
    expect(() => inferNodeGroupSelection(workflow(), [])).toThrow(/select at least one/i)
    const source = workflow()
    source.nodes[1].data.params = { credentialId: "secret-row" }
    expect(() => inferNodeGroupSelection(source, ["selected_a"])).toThrow(/credentialId/)
  })
})

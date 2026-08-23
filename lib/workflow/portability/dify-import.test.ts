import "fake-indexeddb/auto"

import { readFileSync } from "node:fs"
import { join } from "node:path"

jest.mock("@/lib/db/seed", () => ({ seedBuiltIns: jest.fn().mockResolvedValue(undefined) }))

import { getDb } from "@/lib/db/schema"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import type { DifyImportResolver } from "@/types/workflow/dify-import"
import { importDifyDsl, preflightDifyDslImport } from "./dify-import"

const dbFixture = createDbTestFixture({ seeded: false })

beforeAll(dbFixture.initialize)
beforeEach(dbFixture.restore)
afterAll(dbFixture.dispose)

function fixture(name: string): string {
  return readFileSync(join(__dirname, "fixtures", name), "utf8")
}

function resolver(overrides: Partial<DifyImportResolver> = {}): DifyImportResolver {
  return {
    resolvePlugin: async () => "acme/review-tools",
    resolveModel: async ({ provider, model }) => ({ provider, model }),
    resolveTool: async ({ toolName }) => ({
      kind: "plugin",
      pluginId: "acme/review-tools",
      toolName,
    }),
    resolveKnowledge: async (datasetId) => datasetId,
    ...overrides,
  }
}

describe("Dify 1.16 DSL import", () => {
  it("preflights the golden chatflow with exact expressions, routing, and action-only HITL", async () => {
    const result = await preflightDifyDslImport(fixture("dify-1.16-core.yml"), {
      workflowId: "wf_dify_core",
      resolver: resolver(),
      now: 10,
    })

    expect(result.ok).toBe(true)
    expect(result.profile).toBe("dify-1.16")
    expect(result.appMode).toBe("chatflow")
    expect(result.workflow).toMatchObject({
      id: "wf_dify_core",
      name: "Dify Core Import",
      variables: { REGION: "us-east" },
      interface: {
        inputSchema: {
          required: ["query"],
          properties: { query: { type: "string", title: "Query" } },
        },
      },
    })
    expect(result.workflow?.nodes.find((node) => node.id === "llm")).toMatchObject({
      type: "ai.prompt",
      typeVersion: 2,
      data: { params: { userPrompt: '{{ $trigger.payload["query"] }}', piiGate: "redact" } },
    })
    expect(result.workflow?.nodes.find((node) => node.id === "human")).toMatchObject({
      type: "action.humanInput.request",
      data: {
        params: {
          fields: [],
          actions: [{ id: "approve", label: "Approve", tone: "primary" }],
          assignees: [{ kind: "initiator" }],
          timeoutMs: 259_200_000,
        },
      },
    })
    expect(result.workflow?.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: "branch", sourceHandle: "default", target: "answer" }),
        expect.objectContaining({ source: "human", sourceHandle: "approve", target: "answer" }),
      ])
    )
  })

  it("expands a Dify question classifier into classify plus deterministic switch routing", async () => {
    const result = await preflightDifyDslImport(fixture("dify-1.16-classifier-tool.yml"), {
      workflowId: "wf_dify_classifier",
      resolver: resolver(),
      now: 10,
    })

    expect(result.ok).toBe(true)
    expect(result.workflow?.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "classifier", type: "ai.classify" }),
        expect.objectContaining({ id: "classifier__route", type: "flow.switch", typeVersion: 2 }),
        expect.objectContaining({
          id: "tool",
          type: "action.plugin.invoke",
          data: expect.objectContaining({
            label: "Billing tool",
            params: expect.objectContaining({
              pluginId: "acme/review-tools",
              toolName: "lookup_invoice",
              args: { query: '{{ $trigger.payload["query"] }}' },
            }),
            importedFrom: { profile: "dify-1.16", nodeType: "tool" },
          }),
        }),
      ])
    )
    expect(result.workflow?.edges).toEqual(
      expect.arrayContaining([
        { id: "classifier__to_route", source: "classifier", target: "classifier__route" },
        expect.objectContaining({
          id: "e2",
          source: "classifier__route",
          sourceHandle: "billing",
          target: "tool",
        }),
      ])
    )
  })

  it("maps Dify Knowledge Retrieval to the native ACL-aware retriever", async () => {
    const result = await preflightDifyDslImport(fixture("dify-1.16-knowledge.yml"), {
      workflowId: "wf_dify_knowledge",
      resolver: resolver({
        resolveKnowledge: async (datasetId) => `kb_${datasetId}`,
      }),
      now: 10,
    })

    expect(result.ok).toBe(true)
    expect(result.workflow?.nodes.find((node) => node.id === "retrieve")).toMatchObject({
      type: "knowledge.retrieve",
      typeVersion: 1,
      data: {
        params: {
          knowledgeBaseIds: ["kb_dataset-product", "kb_dataset-support"],
          query: '{{ $trigger.payload["query"] }}',
          topKPerBase: 6,
          scoreThreshold: 0.72,
          tokenBudget: 4000,
        },
      },
    })
  })

  it("blocks the entire Knowledge Retrieval import when one dataset is unresolved", async () => {
    const source = fixture("dify-1.16-knowledge.yml")
    const unresolved = resolver({
      resolveKnowledge: async (datasetId) =>
        datasetId === "dataset-product" ? "kb_product" : undefined,
    })

    const result = await preflightDifyDslImport(source, {
      workflowId: "wf_dify_missing_knowledge",
      resolver: unresolved,
    })
    expect(result.ok).toBe(false)
    expect(result.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "missing_knowledge",
          message: "Knowledge dataset dataset-support is unresolved",
        }),
      ])
    )
    await expect(
      importDifyDsl(source, {
        workflowId: "wf_dify_missing_knowledge",
        resolver: unresolved,
      })
    ).rejects.toThrow("preflight failed")
    expect(await getDb().workflows.count()).toBe(0)
  })

  it("blocks unresolved dependencies and leaves the database unchanged", async () => {
    const source = fixture("dify-1.16-core.yml")
    const unresolved = resolver({
      resolvePlugin: async () => undefined,
      resolveModel: async () => undefined,
    })

    const result = await preflightDifyDslImport(source, {
      workflowId: "wf_dify_blocked",
      resolver: unresolved,
    })
    expect(result.ok).toBe(false)
    expect(result.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "missing_plugin" }),
        expect.objectContaining({ code: "missing_model" }),
      ])
    )
    await expect(
      importDifyDsl(source, { workflowId: "wf_dify_blocked", resolver: unresolved })
    ).rejects.toThrow("preflight failed")
    expect(await getDb().workflows.count()).toBe(0)
  })

  it("rejects unsupported nodes and embedded secret environment values with zero writes", async () => {
    const source = `
version: 0.7.0
kind: app
app: { name: Unsafe, mode: workflow }
dependencies: []
workflow:
  environment_variables:
    - { name: API_TOKEN, value_type: secret, value: sk-secret }
  graph:
    nodes:
      - id: start
        position: { x: 0, y: 0 }
        data: { type: start, title: Start, variables: [] }
      - id: code
        position: { x: 200, y: 0 }
        data: { type: code, title: Code, code_language: python3, code: "print('x')" }
    edges:
      - { id: e1, source: start, target: code }
`
    const result = await preflightDifyDslImport(source, {
      workflowId: "wf_dify_unsafe",
      resolver: resolver(),
    })

    expect(result.ok).toBe(false)
    expect(result.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "unsupported_node" }),
        expect.objectContaining({ code: "secret_value_present" }),
      ])
    )
    expect(await getDb().workflows.count()).toBe(0)
  })

  it("imports exactly once and reports a deterministic workflow conflict", async () => {
    const source = fixture("dify-1.16-core.yml")
    await expect(
      importDifyDsl(source, { workflowId: "wf_dify_once", resolver: resolver(), now: 10 })
    ).resolves.toMatchObject({ workflowId: "wf_dify_once", appMode: "chatflow" })
    await expect(
      importDifyDsl(source, { workflowId: "wf_dify_once", resolver: resolver(), now: 20 })
    ).rejects.toThrow("already exists")
    expect(await getDb().workflows.where("id").equals("wf_dify_once").count()).toBe(1)
  })
})

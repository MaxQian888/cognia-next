import "fake-indexeddb/auto"

jest.mock("@/lib/db/seed", () => ({ seedBuiltIns: jest.fn().mockResolvedValue(undefined) }))

import { createDbTestFixture } from "@/lib/db/test-fixture"
import { getDb } from "@/lib/db/schema"
import { createTemplateDefinition } from "@/lib/templates/contracts"
import { DEFAULT_WORKFLOW_SETTINGS, type VisualWorkflow } from "@/types/workflow/visual"
import {
  createWorkflowPortableBundle,
  importWorkflowPortableBundle,
  preflightWorkflowPortableBundle,
  type WorkflowPortableResolver,
} from "./portable-bundle"

const dbFixture = createDbTestFixture({ seeded: false })

beforeAll(dbFixture.initialize)
beforeEach(dbFixture.restore)
afterAll(dbFixture.dispose)

function workflow(overrides: Partial<VisualWorkflow> = {}): VisualWorkflow {
  return {
    id: "workflow-portable-1",
    schemaVersion: 2,
    name: "Portable workflow",
    createdAt: 1,
    updatedAt: 2,
    nodes: [
      {
        id: "trigger",
        type: "trigger.manual",
        typeVersion: 1,
        position: { x: 0, y: 0 },
        data: { label: "Start", params: {} },
      },
      {
        id: "prompt",
        type: "ai.prompt",
        typeVersion: 1,
        position: { x: 100, y: 0 },
        data: {
          label: "Prompt",
          params: { modelId: "provider/model-1", toolId: "tool-1" },
        },
      },
    ],
    edges: [{ id: "edge-1", source: "trigger", target: "prompt" }],
    settings: DEFAULT_WORKFLOW_SETTINGS,
    interface: { inputSchema: { type: "object" }, outputSchema: { type: "object" } },
    credentials: { provider: { id: "secret-ref-1", name: "Provider key" } },
    pinData: { prompt: { text: "not portable" } },
    staticData: { cursor: "not portable" },
    published: { at: 2, toolName: "portable_workflow" },
    ...overrides,
  }
}

function resolver(overrides: Partial<WorkflowPortableResolver> = {}): WorkflowPortableResolver {
  return {
    hasPlugin: async () => true,
    hasModel: async () => true,
    hasTool: async () => true,
    hasKnowledge: async () => true,
    hasSecretRef: async () => true,
    ...overrides,
  }
}

describe("Portable Bundle", () => {
  it("exports a digest-protected graph without runtime state or secret values", async () => {
    const bundle = await createWorkflowPortableBundle({ workflow: workflow(), now: 10 })

    expect(bundle.apiVersion).toBe("cognia.ai/workflow-bundle/v1")
    expect(bundle.digest).toMatch(/^[a-f0-9]{64}$/)
    expect(bundle.workflows[0]).not.toHaveProperty("published")
    expect(bundle.workflows[0]).not.toHaveProperty("pinData")
    expect(bundle.workflows[0]).not.toHaveProperty("staticData")
    expect(bundle.workflows[0].credentials).toEqual({
      provider: { id: "secret-ref-1", name: "Provider key" },
    })
    expect(bundle.dependencies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "model", id: "provider/model-1" }),
        expect.objectContaining({ kind: "tool", id: "tool-1" }),
        expect.objectContaining({ kind: "secret", id: "secret-ref-1" }),
      ])
    )
  })

  it("rejects embedded secret material before creating a bundle", async () => {
    const unsafe = workflow()
    unsafe.nodes[1].data.params.apiKey = "sk-live-secret"

    await expect(createWorkflowPortableBundle({ workflow: unsafe })).rejects.toThrow(
      "contains a secret value"
    )
  })

  it("blocks unresolved dependencies without writing workflows or templates", async () => {
    const template = await createTemplateDefinition({
      id: "portable-template",
      domain: "workflow",
      status: "published",
      revision: 1,
      version: "1.0.0",
      metadata: { name: "Portable template" },
      payload: { workflowId: "workflow-portable-1" },
      inputs: [],
      dependencies: [],
      capabilities: [],
      compatibility: { platforms: ["desktop"] },
      provenance: { source: "file" },
    })
    const bundle = await createWorkflowPortableBundle({
      workflow: workflow(),
      templates: [template],
    })
    const text = JSON.stringify(bundle)

    const preflight = await preflightWorkflowPortableBundle(
      text,
      resolver({ hasModel: async () => false })
    )
    expect(preflight.ok).toBe(false)
    expect(preflight.blockers).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "missing_model" })])
    )
    await expect(
      importWorkflowPortableBundle(text, resolver({ hasModel: async () => false }))
    ).rejects.toThrow("preflight failed")
    expect(await getDb().workflows.count()).toBe(0)
    expect(await getDb().templateDefinitions.count()).toBe(0)
  })

  it("atomically imports a fully resolved workflow and template", async () => {
    const template = await createTemplateDefinition({
      id: "portable-template",
      domain: "workflow",
      status: "published",
      revision: 1,
      version: "1.0.0",
      metadata: { name: "Portable template" },
      payload: { workflowId: "workflow-portable-1" },
      inputs: [],
      dependencies: [],
      capabilities: [],
      compatibility: { platforms: ["desktop", "web"] },
      provenance: { source: "file" },
    })
    const bundle = await createWorkflowPortableBundle({
      workflow: workflow(),
      templates: [template],
    })

    await expect(importWorkflowPortableBundle(JSON.stringify(bundle), resolver())).resolves.toEqual(
      {
        workflowIds: ["workflow-portable-1"],
        templateIds: ["portable-template"],
      }
    )
    expect(await getDb().workflows.get("workflow-portable-1")).toMatchObject({
      name: "Portable workflow",
    })
    expect(await getDb().templateDefinitions.get("release:portable-template@1.0.0")).toMatchObject({
      id: "portable-template",
    })
  })

  it("detects digest tampering and performs zero writes", async () => {
    const bundle = await createWorkflowPortableBundle({ workflow: workflow() })
    bundle.workflows[0].name = "Tampered"

    await expect(importWorkflowPortableBundle(JSON.stringify(bundle), resolver())).rejects.toThrow(
      "digest mismatch"
    )
    expect(await getDb().workflows.count()).toBe(0)
  })
})

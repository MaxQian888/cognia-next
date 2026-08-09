import { getDb } from "@/lib/db/schema"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import { createWorkflow, getWorkflow, updateWorkflow } from "@/lib/db/workflows"
import {
  publishWorkflow,
  unpublishWorkflow,
  derivePublishedInterface,
  toolNameForWorkflow,
  workflowSkillCanonicalId,
  WORKFLOW_RUNNER_TOOL_NAME,
} from "./publish-workflow"
import type { VisualWorkflow } from "@/types/workflow/visual"

const dbFixture = createDbTestFixture()

beforeAll(dbFixture.initialize)
beforeEach(async () => {
  await dbFixture.restore()
})
afterAll(dbFixture.dispose)

const inputSchema = {
  type: "object",
  properties: { topic: { type: "string" } },
  required: ["topic"],
}
const outputSchema = {
  type: "object",
  properties: { summary: { type: "string" } },
  required: ["summary"],
}

function nodesWithInterface() {
  return [
    {
      id: "n_start",
      type: "trigger.manual" as const,
      typeVersion: 1,
      position: { x: 0, y: 0 },
      data: { label: "start", params: { inputSchema } },
    },
    {
      id: "n_out",
      type: "io.output" as const,
      typeVersion: 1,
      position: { x: 200, y: 0 },
      data: { label: "output", params: { outputSchema } },
    },
  ]
}

describe("derivePublishedInterface", () => {
  it("collects the input + output schemas from the canvas", () => {
    const wf = { nodes: nodesWithInterface() } as unknown as VisualWorkflow
    expect(derivePublishedInterface(wf)).toEqual({ inputSchema, outputSchema })
  })

  it("returns an empty interface when no schemas are declared", () => {
    const wf = {
      nodes: [
        {
          id: "n",
          type: "trigger.manual",
          typeVersion: 1,
          position: { x: 0, y: 0 },
          data: { label: "s", params: {} },
        },
      ],
    } as unknown as VisualWorkflow
    expect(derivePublishedInterface(wf)).toEqual({})
  })
})

describe("toolNameForWorkflow", () => {
  it("slugs the name into a stable tool id", () => {
    expect(toolNameForWorkflow({ name: "Summarize PRs!" })).toBe("wf_summarize_prs")
    expect(toolNameForWorkflow({ name: "  " })).toBe("wf_workflow")
  })
})

describe("publishWorkflow", () => {
  it("creates an immutable version, deploys it, and registers a kind:workflow skill", async () => {
    const wf = await createWorkflow({ name: "Summarizer", nodes: nodesWithInterface(), edges: [] })
    const result = await publishWorkflow(wf.id, 123)

    expect(result.created).toBe(true)
    expect(result.toolName).toBe("wf_summarizer")
    expect(result.workflowInterface).toEqual({ inputSchema, outputSchema })

    const reloaded = await getWorkflow(wf.id)
    expect(reloaded?.published).toEqual({
      at: 123,
      toolName: "wf_summarizer",
      versionId: result.versionId,
      deploymentId: result.deploymentId,
      deploymentRevision: 1,
    })
    expect(reloaded?.interface).toEqual({ inputSchema, outputSchema })

    const version = await getDb().workflowVersions.get(result.versionId)
    expect(version).toMatchObject({
      id: result.versionId,
      workflowId: wf.id,
      sequence: 1,
      name: "Summarizer",
      interface: { inputSchema, outputSchema },
      digest: expect.stringMatching(/^wfv1:[0-9a-f]{32}$/),
    })
    expect(version?.definition.published).toBeUndefined()
    const deployment = await getDb().workflowDeployments.get(result.deploymentId)
    expect(deployment).toMatchObject({
      workflowId: wf.id,
      environment: "production",
      versionId: result.versionId,
      revision: 1,
      status: "active",
    })

    const skill = await getDb().skills.get(result.skillId)
    expect(skill?.kind).toBe("workflow")
    expect(skill?.workflowId).toBe(wf.id)
    expect(skill?.canonicalId).toBe(workflowSkillCanonicalId(wf.id))
    // The body must point at the REAL registered runner tool with the workflow
    // name — never at the display-only `wf_<slug>` (no such tool is ever
    // registered; a body naming it strands the model on a ghost tool).
    expect(skill?.content).toContain(WORKFLOW_RUNNER_TOOL_NAME)
    expect(skill?.content).toContain('"name": "Summarizer"')
    expect(skill?.content).not.toMatch(/wf_summarizer/)
  })

  it("is idempotent — re-publish updates the same skill row", async () => {
    const wf = await createWorkflow({ name: "Summarizer", nodes: nodesWithInterface(), edges: [] })
    const first = await publishWorkflow(wf.id, 1)
    const second = await publishWorkflow(wf.id, 2)
    expect(second.created).toBe(false)
    expect(second.skillId).toBe(first.skillId)
    expect(second.versionId).not.toBe(first.versionId)
    expect(second.deploymentId).toBe(first.deploymentId)
    expect(second.deploymentRevision).toBe(2)
    expect(await getDb().workflowVersions.count()).toBe(2)
    const all = await getDb().skills.toArray()
    const matching = all.filter((s) => s.canonicalId === workflowSkillCanonicalId(wf.id))
    expect(matching).toHaveLength(1)
  })

  it("keeps the deployed version immutable when the draft implementation changes", async () => {
    const wf = await createWorkflow({ name: "Immutable", nodes: nodesWithInterface(), edges: [] })
    const published = await publishWorkflow(wf.id, 123)

    await updateWorkflow(wf.id, {
      nodes: [
        ...nodesWithInterface(),
        {
          id: "n_prompt",
          type: "ai.prompt",
          typeVersion: 1,
          position: { x: 100, y: 100 },
          data: { label: "changed", params: { prompt: "changed after publish" } },
        },
      ],
    })

    const version = await getDb().workflowVersions.get(published.versionId)
    expect(version?.definition.nodes).toEqual(nodesWithInterface())
    expect((await getWorkflow(wf.id))?.nodes).toHaveLength(3)
    expect((await getWorkflow(wf.id))?.published?.versionId).toBe(published.versionId)
  })

  it("serializes concurrent publish attempts into one generated skill", async () => {
    const wf = await createWorkflow({ name: "Concurrent", nodes: nodesWithInterface(), edges: [] })
    const results = await Promise.all([
      publishWorkflow(wf.id, 1),
      publishWorkflow(wf.id, 2),
      publishWorkflow(wf.id, 3),
    ])

    expect(new Set(results.map((result) => result.skillId)).size).toBe(1)
    const matching = (await getDb().skills.toArray()).filter(
      (skill) => skill.canonicalId === workflowSkillCanonicalId(wf.id)
    )
    expect(matching).toHaveLength(1)
  })

  it("keeps the deployed identity stable across draft renames", async () => {
    const wf = await createWorkflow({ name: "Old name", nodes: nodesWithInterface(), edges: [] })
    const published = await publishWorkflow(wf.id, 123)

    await updateWorkflow(wf.id, { name: "New name", description: "Updated description" })

    const reloaded = await getWorkflow(wf.id)
    expect(reloaded?.published).toMatchObject({ at: 123, toolName: "wf_old_name" })
    const skill = await getDb().skills.get(published.skillId)
    expect(skill).toMatchObject({
      id: published.skillId,
      name: "Old name",
      canonicalId: workflowSkillCanonicalId(wf.id),
      kind: "workflow",
      workflowId: wf.id,
    })
    expect(skill?.content).toContain('"name": "Old name"')
  })

  it("throws for an unknown workflow", async () => {
    await expect(publishWorkflow("wf_nope", 1)).rejects.toThrow(/not found/)
  })

  it("blocks new publications that still contain legacy data.code@1", async () => {
    const wf = await createWorkflow({
      name: "Legacy code",
      nodes: [
        {
          id: "code",
          type: "data.code",
          typeVersion: 1,
          position: { x: 0, y: 0 },
          data: { label: "code", params: { code: "return input" } },
        },
      ],
      edges: [],
    })

    await expect(publishWorkflow(wf.id, 1)).rejects.toThrow(/data\.code@1/)
    expect(await getDb().workflowVersions.count()).toBe(0)
  })
})

describe("unpublishWorkflow", () => {
  it("clears the publication and removes the skill", async () => {
    const wf = await createWorkflow({ name: "Summarizer", nodes: nodesWithInterface(), edges: [] })
    const published = await publishWorkflow(wf.id, 1)
    await unpublishWorkflow(wf.id)

    const reloaded = await getWorkflow(wf.id)
    expect(reloaded?.published).toBeUndefined()
    expect(reloaded?.interface).toBeUndefined()
    expect(await getDb().skills.get(published.skillId)).toBeUndefined()
  })
})

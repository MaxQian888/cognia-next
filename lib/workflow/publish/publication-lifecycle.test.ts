import { getDb } from "@/lib/db/schema"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import {
  createWorkflow,
  deleteWorkflow,
  duplicateWorkflow,
  getWorkflow,
  replaceWorkflow,
} from "@/lib/db/workflows"
import { createSkill } from "@/lib/db/skills"
import { publishWorkflow, unpublishWorkflow, workflowSkillCanonicalId } from "./publish-workflow"
import { reconcileWorkflowPublications } from "./publication-lifecycle"
import type { VisualWorkflow } from "@/types/workflow/visual"

const dbFixture = createDbTestFixture()

beforeAll(dbFixture.initialize)
beforeEach(async () => {
  await dbFixture.restore()
})
afterAll(dbFixture.dispose)

function nodesWithInputSchema(inputSchema: Record<string, unknown>): VisualWorkflow["nodes"] {
  return [
    {
      id: "n_start",
      type: "trigger.manual",
      typeVersion: 1,
      position: { x: 0, y: 0 },
      data: { label: "start", params: { inputSchema } },
    },
  ]
}

describe("workflow publication lifecycle", () => {
  it("keeps the deployed version active when an editor save changes the draft contract", async () => {
    const originalSchema = {
      type: "object",
      properties: { topic: { type: "string" } },
      required: ["topic"],
    }
    const workflow = await createWorkflow({
      name: "Summarizer",
      nodes: nodesWithInputSchema(originalSchema),
      edges: [],
    })
    const published = await publishWorkflow(workflow.id, 123)

    const result = await replaceWorkflow({
      ...(await getWorkflow(workflow.id))!,
      nodes: nodesWithInputSchema({
        type: "object",
        properties: { url: { type: "string" } },
        required: ["url"],
      }),
    })

    expect(result.publicationInvalidated).toBe(false)
    expect(result.workflow.published?.versionId).toBe(published.versionId)
    expect(result.workflow.interface).toEqual({ inputSchema: originalSchema })
    expect((await getWorkflow(workflow.id))?.published?.versionId).toBe(published.versionId)
    expect(await getDb().skills.get(published.skillId)).toBeDefined()
    expect((await getDb().workflowVersions.get(published.versionId))?.interface).toEqual({
      inputSchema: originalSchema,
    })
  })

  it("deletes the generated skill with its published workflow", async () => {
    const workflow = await createWorkflow({
      name: "Disposable",
      nodes: nodesWithInputSchema({ type: "object" }),
      edges: [],
    })
    const published = await publishWorkflow(workflow.id, 123)
    await getDb().workflows.update(workflow.id, { published: undefined })

    await deleteWorkflow(workflow.id)

    expect(await getWorkflow(workflow.id)).toBeUndefined()
    expect(await getDb().skills.get(published.skillId)).toBeUndefined()
    expect(await getDb().workflowDeployments.get(published.deploymentId)).toMatchObject({
      status: "disabled",
      revision: 2,
    })
  })

  it("disables the deployment even when the legacy publication projection is missing", async () => {
    const workflow = await createWorkflow({
      name: "Projectionless",
      nodes: nodesWithInputSchema({ type: "object" }),
      edges: [],
    })
    const published = await publishWorkflow(workflow.id, 123)
    await getDb().workflows.update(workflow.id, { published: undefined })

    await unpublishWorkflow(workflow.id)

    expect(await getDb().workflowDeployments.get(published.deploymentId)).toMatchObject({
      status: "disabled",
      revision: 2,
    })
    expect(await getDb().skills.get(published.skillId)).toBeUndefined()
  })

  it("duplicates published workflows as unpublished definitions", async () => {
    const workflow = await createWorkflow({
      name: "Published source",
      nodes: nodesWithInputSchema({ type: "object" }),
      edges: [],
    })
    await publishWorkflow(workflow.id, 123)

    const duplicate = await duplicateWorkflow(workflow.id)

    expect(duplicate.published).toBeUndefined()
    expect(
      (await getDb().skills.toArray()).some(
        (skill) => skill.canonicalId === workflowSkillCanonicalId(duplicate.id)
      )
    ).toBe(false)
  })

  it("preserves publication when schema object keys are reordered", async () => {
    const workflow = await createWorkflow({
      name: "Stable contract",
      nodes: nodesWithInputSchema({
        type: "object",
        properties: {
          topic: { type: "string", description: "Topic" },
          limit: { type: "number" },
        },
      }),
      edges: [],
    })
    const published = await publishWorkflow(workflow.id, 123)
    const saved = (await getWorkflow(workflow.id))!

    const result = await replaceWorkflow({
      ...saved,
      nodes: nodesWithInputSchema({
        properties: {
          limit: { type: "number" },
          topic: { description: "Topic", type: "string" },
        },
        type: "object",
      }),
    })

    expect(result.publicationInvalidated).toBe(false)
    expect(result.workflow.published).toMatchObject({ at: 123, toolName: "wf_stable_contract" })
    expect(await getDb().skills.get(published.skillId)).toBeDefined()
  })

  it("preserves publication for implementation-only graph edits", async () => {
    const schema = { type: "object", properties: { topic: { type: "string" } } }
    const workflow = await createWorkflow({
      name: "Stable implementation",
      nodes: nodesWithInputSchema(schema),
      edges: [],
    })
    const published = await publishWorkflow(workflow.id, 123)
    const originalSkill = await getDb().skills.get(published.skillId)

    const result = await replaceWorkflow({
      ...(await getWorkflow(workflow.id))!,
      nodes: [
        ...nodesWithInputSchema(schema),
        {
          id: "n_prompt",
          type: "ai.prompt",
          typeVersion: 1,
          position: { x: 200, y: 0 },
          data: { label: "Prompt", params: { prompt: "Summarize" } },
        },
      ],
    })

    expect(result.publicationInvalidated).toBe(false)
    expect(result.workflow.published).toMatchObject({
      at: 123,
      toolName: "wf_stable_implementation",
    })
    expect(await getDb().skills.get(published.skillId)).toEqual(originalSkill)
  })

  it("idempotently reconciles missing, stale, drifted, and orphan projections", async () => {
    const schema = { type: "object", properties: { topic: { type: "string" } } }

    const missing = await createWorkflow({
      name: "Missing skill",
      nodes: nodesWithInputSchema(schema),
      edges: [],
    })
    const missingPublication = await publishWorkflow(missing.id, 10)
    await getDb().skills.delete(missingPublication.skillId)

    const stale = await createWorkflow({
      name: "Current name",
      description: "Current description",
      nodes: nodesWithInputSchema(schema),
      edges: [],
    })
    const stalePublication = await publishWorkflow(stale.id, 20)
    await getDb().skills.update(stalePublication.skillId, {
      name: "Stale name",
      description: "Stale description",
      content: "stale body",
      kind: "markdown",
      workflowId: "wf_wrong",
      status: "disabled",
      usageCount: 7,
    })

    const drifted = await createWorkflow({
      name: "Drifted contract",
      nodes: nodesWithInputSchema(schema),
      edges: [],
    })
    const driftedPublication = await publishWorkflow(drifted.id, 30)
    await getDb().workflows.update(drifted.id, {
      nodes: nodesWithInputSchema({
        type: "object",
        properties: { url: { type: "string" } },
      }),
    })

    const orphan = await createSkill({
      name: "Orphan",
      description: "Orphan workflow skill",
      content: "orphan",
      canonicalId: workflowSkillCanonicalId("wf_missing"),
      kind: "markdown",
      source: "generated",
    })

    expect(await reconcileWorkflowPublications()).toEqual({
      synchronized: 2,
      invalidated: 0,
      removedSkills: 1,
    })

    const missingSkill = (await getDb().skills.toArray()).find(
      (skill) => skill.canonicalId === workflowSkillCanonicalId(missing.id)
    )
    expect(missingSkill?.name).toBe("Missing skill")

    const repairedStale = await getDb().skills.get(stalePublication.skillId)
    expect(repairedStale).toMatchObject({
      id: stalePublication.skillId,
      name: "Current name",
      description: "Current description",
      kind: "workflow",
      workflowId: stale.id,
      status: "disabled",
      usageCount: 7,
    })

    expect((await getWorkflow(drifted.id))?.published?.versionId).toBe(driftedPublication.versionId)
    expect((await getWorkflow(drifted.id))?.interface).toEqual({ inputSchema: schema })
    expect(await getDb().skills.get(driftedPublication.skillId)).toBeDefined()
    expect(await getDb().skills.get(orphan.id)).toBeUndefined()

    expect(await reconcileWorkflowPublications()).toEqual({
      synchronized: 0,
      invalidated: 0,
      removedSkills: 0,
    })
  })

  it("rolls back publication metadata when its Skill update fails", async () => {
    const workflow = await createWorkflow({
      name: "Atomic publication",
      nodes: nodesWithInputSchema({ type: "object" }),
      edges: [],
    })
    const first = await publishWorkflow(workflow.id, 10)
    const beforeWorkflow = await getWorkflow(workflow.id)
    const beforeSkill = await getDb().skills.get(first.skillId)
    const update = jest
      .spyOn(getDb().skills, "update")
      .mockRejectedValueOnce(new Error("skill write failed"))

    await expect(publishWorkflow(workflow.id, 20)).rejects.toThrow("skill write failed")
    update.mockRestore()

    expect(await getWorkflow(workflow.id)).toEqual(beforeWorkflow)
    expect(await getDb().skills.get(first.skillId)).toEqual(beforeSkill)
  })
})

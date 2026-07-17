/**
 * @jest-environment jsdom
 */
import "fake-indexeddb/auto"
import { __resetDbForTesting, getDb, whenSeeded } from "@/lib/db/schema"
import { createWorkflow, getWorkflow } from "@/lib/db/workflows"
import {
  publishWorkflow,
  unpublishWorkflow,
  derivePublishedInterface,
  toolNameForWorkflow,
  workflowSkillCanonicalId,
  WORKFLOW_RUNNER_TOOL_NAME,
} from "./publish-workflow"
import type { VisualWorkflow } from "@/types/workflow/visual"

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
})

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
  it("stamps the interface + publication and registers a kind:workflow skill", async () => {
    const wf = await createWorkflow({ name: "Summarizer", nodes: nodesWithInterface(), edges: [] })
    const result = await publishWorkflow(wf.id, 123)

    expect(result.created).toBe(true)
    expect(result.toolName).toBe("wf_summarizer")
    expect(result.workflowInterface).toEqual({ inputSchema, outputSchema })

    const reloaded = await getWorkflow(wf.id)
    expect(reloaded?.published).toEqual({ at: 123, toolName: "wf_summarizer" })
    expect(reloaded?.interface).toEqual({ inputSchema, outputSchema })

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
    const all = await getDb().skills.toArray()
    const matching = all.filter((s) => s.canonicalId === workflowSkillCanonicalId(wf.id))
    expect(matching).toHaveLength(1)
  })

  it("throws for an unknown workflow", async () => {
    await expect(publishWorkflow("wf_nope", 1)).rejects.toThrow(/not found/)
  })
})

describe("unpublishWorkflow", () => {
  it("clears the publication and removes the skill", async () => {
    const wf = await createWorkflow({ name: "Summarizer", nodes: nodesWithInterface(), edges: [] })
    const published = await publishWorkflow(wf.id, 1)
    await unpublishWorkflow(wf.id)

    const reloaded = await getWorkflow(wf.id)
    expect(reloaded?.published).toBeUndefined()
    expect(await getDb().skills.get(published.skillId)).toBeUndefined()
  })
})

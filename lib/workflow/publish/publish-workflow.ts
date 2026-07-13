/**
 * Publish a workflow as a typed callable unit (D5) — the n8n `ToolWorkflow` /
 * Dify `WORKFLOW` provider pattern.
 *
 * The declared interface (input/output JSON Schemas) is authored on the canvas:
 * the `trigger.manual` node's `inputSchema` param and the `io.output` node's
 * `outputSchema` param. Publishing derives `workflow.interface` from those,
 * stamps `workflow.published`, and registers a skill-catalog entry of
 * `kind:"workflow"` whose body points the model at the typed agent tool
 * (`wf_run_workflow_typed`). The same interface lets a typed `flow.subworkflow`
 * validate calls.
 *
 * Interface (schema) is declared separately from implementation (the graph);
 * callers see only the interface.
 */

import type { VisualWorkflow, WorkflowInterface } from "@/types/workflow/visual"
import { getWorkflow, updateWorkflow } from "@/lib/db/workflows"
import { getDb } from "@/lib/db/schema"
import { createSkill, updateSkill, deleteSkill } from "@/lib/db/skills"
import type { Skill } from "@cognia/agent-config-types"

/** Canonical id of the skill-catalog entry backing a published workflow. */
export function workflowSkillCanonicalId(workflowId: string): string {
  return `workflow:${workflowId}`
}

/** Stable, slug-based tool name the agent calls to run the workflow. */
export function toolNameForWorkflow(workflow: Pick<VisualWorkflow, "name">): string {
  const slug = workflow.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40)
  return `wf_${slug || "workflow"}`
}

/** Scan the canvas for the declared input/output schemas. */
export function derivePublishedInterface(workflow: VisualWorkflow): WorkflowInterface {
  let inputSchema: Record<string, unknown> | undefined
  let outputSchema: Record<string, unknown> | undefined
  const hasProps = (s: unknown): s is Record<string, unknown> =>
    !!s && typeof s === "object" && Object.keys(s as object).length > 0
  for (const node of workflow.nodes) {
    const params = (node.data?.params ?? {}) as Record<string, unknown>
    if (node.type === "trigger.manual" && hasProps(params.inputSchema)) {
      inputSchema = params.inputSchema as Record<string, unknown>
    }
    if (node.type === "io.output" && hasProps(params.outputSchema)) {
      outputSchema = params.outputSchema as Record<string, unknown>
    }
  }
  return {
    ...(inputSchema ? { inputSchema } : {}),
    ...(outputSchema ? { outputSchema } : {}),
  }
}

/** The skill body for a graph-bodied skill — points the model at the tool. */
function workflowSkillContent(name: string, toolName: string): string {
  return [
    `# ${name}`,
    "",
    `This skill runs the **${name}** workflow as a typed tool.`,
    "",
    `When this skill is relevant, call the \`${toolName}\` tool with the declared ` +
      `input — it executes the workflow graph and returns its typed output. Do NOT ` +
      `try to perform the steps yourself; the workflow runs them deterministically.`,
  ].join("\n")
}

async function findWorkflowSkill(canonicalId: string): Promise<Skill | undefined> {
  const all = await getDb().skills.toArray()
  return all.find((s) => s.canonicalId === canonicalId)
}

export interface PublishResult {
  toolName: string
  workflowInterface: WorkflowInterface
  skillId: string
  created: boolean
}

/**
 * Publish (or re-publish) the workflow. Idempotent: re-publishing refreshes the
 * derived interface, the publication timestamp, and the skill entry.
 */
export async function publishWorkflow(workflowId: string, at: number): Promise<PublishResult> {
  const workflow = await getWorkflow(workflowId)
  if (!workflow) throw new Error(`publishWorkflow: workflow ${workflowId} not found`)

  const workflowInterface = derivePublishedInterface(workflow)
  const toolName = toolNameForWorkflow(workflow)

  await updateWorkflow(workflowId, {
    interface: workflowInterface,
    published: { at, toolName },
  })

  const canonicalId = workflowSkillCanonicalId(workflowId)
  const existing = await findWorkflowSkill(canonicalId)
  const draft = {
    name: workflow.name,
    description: workflow.description?.trim() || `Run the "${workflow.name}" workflow.`,
    content: workflowSkillContent(workflow.name, toolName),
    category: "meta" as const,
    source: "generated" as const,
    canonicalId,
    kind: "workflow" as const,
    workflowId,
  }

  if (existing) {
    await updateSkill(existing.id, {
      name: draft.name,
      description: draft.description,
      content: draft.content,
      kind: "workflow",
      workflowId,
    })
    return { toolName, workflowInterface, skillId: existing.id, created: false }
  }
  const skill = await createSkill(draft)
  return { toolName, workflowInterface, skillId: skill.id, created: true }
}

/** Unpublish: clear the publication and drop the backing skill entry. */
export async function unpublishWorkflow(workflowId: string): Promise<void> {
  await updateWorkflow(workflowId, { published: undefined })
  const existing = await findWorkflowSkill(workflowSkillCanonicalId(workflowId))
  if (existing) await deleteSkill(existing.id)
}

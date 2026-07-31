import type { Skill } from "@cognia/agent-config-types"

import { getDb, withDbReopenRetry } from "@/lib/db/schema"
import { upsertSkillByCanonicalId, workflowSkillBody } from "@/lib/db/skills"
import { migrateWorkflow } from "@/lib/workflow/definition/migrate"
import type { VisualWorkflow, WorkflowInterface } from "@/types/workflow/visual"

/** Canonical id of the skill-catalog entry backing a published workflow. */
export function workflowSkillCanonicalId(workflowId: string): string {
  return `workflow:${workflowId}`
}

function workflowIdFromSkillCanonicalId(canonicalId?: string): string | undefined {
  if (!canonicalId?.startsWith("workflow:")) return undefined
  const workflowId = canonicalId.slice("workflow:".length)
  return workflowId || undefined
}

/**
 * Slug-based publication identifier shown in the UI. Workflow execution still
 * goes through the single shared `wf_run_workflow_typed` runner.
 */
export function toolNameForWorkflow(workflow: Pick<VisualWorkflow, "name">): string {
  const slug = workflow.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40)
  return `wf_${slug || "workflow"}`
}

/** Scan the canvas for its declared callable input/output schemas. */
export function derivePublishedInterface(workflow: VisualWorkflow): WorkflowInterface {
  let inputSchema: Record<string, unknown> | undefined
  let outputSchema: Record<string, unknown> | undefined
  const hasProps = (schema: unknown): schema is Record<string, unknown> =>
    Boolean(schema) && typeof schema === "object" && Object.keys(schema as object).length > 0

  for (const node of workflow.nodes) {
    const params = (node.data?.params ?? {}) as Record<string, unknown>
    if (node.type === "trigger.manual" && hasProps(params.inputSchema)) {
      inputSchema = params.inputSchema
    }
    if (node.type === "io.output" && hasProps(params.outputSchema)) {
      outputSchema = params.outputSchema
    }
  }

  return {
    ...(inputSchema ? { inputSchema } : {}),
    ...(outputSchema ? { outputSchema } : {}),
  }
}

function normalizeStoredValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeStoredValue)
  if (!value || typeof value !== "object") return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, nested]) => nested !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, normalizeStoredValue(nested)])
  )
}

/** Key-order-independent equality matching the JSON value Dexie persists. */
export function workflowInterfacesEqual(
  left: WorkflowInterface | undefined,
  right: WorkflowInterface | undefined
): boolean {
  return (
    JSON.stringify(normalizeStoredValue(left ?? {})) ===
    JSON.stringify(normalizeStoredValue(right ?? {}))
  )
}

function workflowSkillDescription(workflow: Pick<VisualWorkflow, "name" | "description">): string {
  return workflow.description?.trim() || `Run the "${workflow.name}" workflow.`
}

function expectedWorkflowSkill(workflow: VisualWorkflow) {
  return {
    name: workflow.name,
    description: workflowSkillDescription(workflow),
    content: workflowSkillBody(workflow.name),
    category: "meta" as const,
    source: "generated" as const,
    canonicalId: workflowSkillCanonicalId(workflow.id),
    kind: "workflow" as const,
    workflowId: workflow.id,
  }
}

function workflowSkillNeedsSync(existing: Skill | undefined, workflow: VisualWorkflow): boolean {
  if (!existing) return true
  const expected = expectedWorkflowSkill(workflow)
  return (
    existing.name !== expected.name ||
    existing.description !== expected.description ||
    existing.content !== expected.content ||
    existing.category !== expected.category ||
    existing.source !== expected.source ||
    existing.canonicalId !== expected.canonicalId ||
    existing.kind !== expected.kind ||
    existing.workflowId !== expected.workflowId
  )
}

async function syncWorkflowSkill(
  workflow: VisualWorkflow,
  existing?: Skill
): Promise<{ skill: Skill; created: boolean }> {
  const canonicalId = workflowSkillCanonicalId(workflow.id)
  return upsertSkillByCanonicalId({
    canonicalId,
    draft: expectedWorkflowSkill(workflow),
    existingByCanonicalId: new Map(existing ? [[canonicalId, existing]] : []),
  })
}

async function findWorkflowSkill(workflowId: string): Promise<Skill | undefined> {
  const canonicalId = workflowSkillCanonicalId(workflowId)
  return (await getDb().skills.toArray()).find((skill) => skill.canonicalId === canonicalId)
}

export interface PublishWorkflowResult {
  toolName: string
  workflowInterface: WorkflowInterface
  skillId: string
  created: boolean
}

/** Explicitly publish or re-publish a workflow and its generated Skill. */
export async function publishWorkflowLifecycle(
  workflowId: string,
  at: number
): Promise<PublishWorkflowResult> {
  const skillBeforePublish = await findWorkflowSkill(workflowId)
  try {
    return await withDbReopenRetry(() => {
      const db = getDb()
      return db.transaction("rw", db.workflows, db.skills, () =>
        Promise.all([db.workflows.get(workflowId), db.skills.toArray()]).then(
          ([stored, skills]) => {
            if (!stored) throw new Error(`publishWorkflow: workflow ${workflowId} not found`)

            const existing = migrateWorkflow(stored)
            const workflowInterface = derivePublishedInterface(existing)
            const toolName = toolNameForWorkflow(existing)
            const workflow: VisualWorkflow = {
              ...existing,
              interface: workflowInterface,
              published: { at, toolName },
              updatedAt: Date.now(),
            }
            const canonicalId = workflowSkillCanonicalId(workflowId)
            const existingSkill = skills.find((skill) => skill.canonicalId === canonicalId)
            return db.workflows
              .put(workflow)
              .then(() => syncWorkflowSkill(workflow, existingSkill))
              .then(({ skill, created }) => ({
                toolName,
                workflowInterface,
                skillId: skill.id,
                created,
              }))
          }
        )
      )
    })
  } catch (error) {
    // fake-indexeddb can report a late PrematureCommitError after both writes
    // are already durable. Accept that race only when the full publication
    // projection (workflow contract + generated Skill) is present and exact.
    const db = getDb()
    const [stored, skill] = await Promise.all([
      db.workflows.get(workflowId),
      findWorkflowSkill(workflowId),
    ])
    if (!stored || !skill) throw error
    const workflow = migrateWorkflow(stored)
    const workflowInterface = derivePublishedInterface(workflow)
    const toolName = toolNameForWorkflow(workflow)
    if (
      workflow.published?.at !== at ||
      workflow.published.toolName !== toolName ||
      !workflowInterfacesEqual(workflow.interface, workflowInterface) ||
      workflowSkillNeedsSync(skill, workflow)
    ) {
      throw error
    }
    return {
      toolName,
      workflowInterface,
      skillId: skill.id,
      created: skillBeforePublish === undefined,
    }
  }
}

/** Explicitly remove a workflow's callable contract and generated Skill. */
export async function unpublishWorkflowLifecycle(workflowId: string): Promise<void> {
  const db = getDb()
  await db.transaction("rw", db.workflows, db.skills, async () => {
    const stored = await db.workflows.get(workflowId)
    if (stored) {
      await db.workflows.put({
        ...migrateWorkflow(stored),
        interface: undefined,
        published: undefined,
        updatedAt: Date.now(),
      })
    }
    const skill = await findWorkflowSkill(workflowId)
    if (skill) await db.skills.delete(skill.id)
  })
}

export interface WorkflowMutationResult {
  workflow: VisualWorkflow
  publicationInvalidated: boolean
}

/**
 * Apply an ordinary workflow edit while keeping an existing publication and
 * its generated Skill consistent in the same Dexie transaction.
 */
export async function updateWorkflowWithPublication(
  id: string,
  patch: Partial<VisualWorkflow>,
  updatedAt: number
): Promise<WorkflowMutationResult | undefined> {
  const db = getDb()
  return db.transaction("rw", db.workflows, db.skills, async () => {
    const stored = await db.workflows.get(id)
    if (!stored) return undefined

    const existing = migrateWorkflow(stored)
    const {
      id: _ignoredId,
      createdAt: _ignoredCreatedAt,
      updatedAt: _ignoredUpdatedAt,
      schemaVersion: _ignoredSchemaVersion,
      interface: _ignoredInterface,
      published: _ignoredPublished,
      ...ordinaryPatch
    } = patch
    let workflow: VisualWorkflow = {
      ...existing,
      ...ordinaryPatch,
      id: existing.id,
      createdAt: existing.createdAt,
      schemaVersion: 2,
      updatedAt,
    }
    let publicationInvalidated = false

    if (existing.published) {
      const derivedInterface = derivePublishedInterface(workflow)
      if (!workflowInterfacesEqual(existing.interface, derivedInterface)) {
        workflow = { ...workflow, interface: undefined, published: undefined }
        publicationInvalidated = true
        const skill = await findWorkflowSkill(id)
        if (skill) await db.skills.delete(skill.id)
      } else {
        workflow = {
          ...workflow,
          interface: derivedInterface,
          published: {
            at: existing.published.at,
            toolName: toolNameForWorkflow(workflow),
          },
        }
        const skill = await findWorkflowSkill(id)
        if (workflowSkillNeedsSync(skill, workflow)) {
          await syncWorkflowSkill(workflow, skill)
        }
      }
    } else {
      workflow = {
        ...workflow,
        interface: existing.interface,
        published: undefined,
      }
    }

    await db.workflows.put(workflow)
    return { workflow, publicationInvalidated }
  })
}

/** Replace a full editor snapshot without trusting its publication envelope. */
export function replaceWorkflowWithPublication(
  workflow: VisualWorkflow,
  updatedAt: number
): Promise<WorkflowMutationResult | undefined> {
  return updateWorkflowWithPublication(workflow.id, workflow, updatedAt)
}

/** Atomically remove a workflow definition and its generated Skill row. */
export async function deleteWorkflowWithPublication(workflowId: string): Promise<void> {
  const db = getDb()
  await db.transaction("rw", db.workflows, db.skills, async () => {
    const skill = await findWorkflowSkill(workflowId)
    if (skill) await db.skills.delete(skill.id)
    await db.workflows.delete(workflowId)
  })
}

export interface WorkflowPublicationReconciliationResult {
  synchronized: number
  invalidated: number
  removedSkills: number
}

/**
 * Repair persisted publication projections at startup. This is intentionally
 * idempotent and shares the same contract comparison and Skill upsert path as
 * ordinary writes.
 */
export async function reconcileWorkflowPublications(): Promise<WorkflowPublicationReconciliationResult> {
  const db = getDb()
  const [workflowSnapshot, skillSnapshot] = await Promise.all([
    db.workflows.toArray(),
    db.skills.toArray(),
  ])
  const needsReconciliation =
    workflowSnapshot.some((workflow) => Boolean(workflow.published)) ||
    skillSnapshot.some(
      (skill) => skill.kind === "workflow" || workflowIdFromSkillCanonicalId(skill.canonicalId)
    )
  if (!needsReconciliation) {
    return { synchronized: 0, invalidated: 0, removedSkills: 0 }
  }

  return db.transaction("rw", db.workflows, db.skills, async () => {
    // Schedule both initial reads before awaiting either result. Some
    // IndexedDB implementations auto-commit a readwrite transaction as soon as
    // its request queue drains; a sequential read leaves a gap before the
    // second request and makes the reconciliation writes fail with
    // TransactionInactiveError.
    const [workflowRows, skills] = await Promise.all([db.workflows.toArray(), db.skills.toArray()])
    const workflows = workflowRows.map(migrateWorkflow)
    const workflowById = new Map(workflows.map((workflow) => [workflow.id, workflow]))
    const skillByCanonicalId = new Map<string, Skill>()
    for (const skill of skills) {
      if (skill.canonicalId && !skillByCanonicalId.has(skill.canonicalId)) {
        skillByCanonicalId.set(skill.canonicalId, skill)
      }
    }

    const result: WorkflowPublicationReconciliationResult = {
      synchronized: 0,
      invalidated: 0,
      removedSkills: 0,
    }
    const activePublishedIds = new Set<string>()
    const deletedSkillIds = new Set<string>()

    for (const workflow of workflows) {
      if (!workflow.published) continue
      const canonicalId = workflowSkillCanonicalId(workflow.id)
      const existingSkill = skillByCanonicalId.get(canonicalId)
      const derivedInterface = derivePublishedInterface(workflow)

      if (!workflowInterfacesEqual(workflow.interface, derivedInterface)) {
        const invalidated: VisualWorkflow = {
          ...workflow,
          interface: undefined,
          published: undefined,
          updatedAt: Date.now(),
        }
        await db.workflows.put(invalidated)
        workflowById.set(workflow.id, invalidated)
        if (existingSkill) {
          await db.skills.delete(existingSkill.id)
          deletedSkillIds.add(existingSkill.id)
        }
        result.invalidated += 1
        continue
      }

      activePublishedIds.add(workflow.id)
      const canonicalWorkflow: VisualWorkflow = {
        ...workflow,
        interface: derivedInterface,
        published: {
          at: workflow.published.at,
          toolName: toolNameForWorkflow(workflow),
        },
      }
      if (
        !workflowInterfacesEqual(workflow.interface, canonicalWorkflow.interface) ||
        workflow.published.toolName !== canonicalWorkflow.published?.toolName
      ) {
        await db.workflows.put(canonicalWorkflow)
        workflowById.set(workflow.id, canonicalWorkflow)
      }
      if (workflowSkillNeedsSync(existingSkill, canonicalWorkflow)) {
        const synced = await syncWorkflowSkill(canonicalWorkflow, existingSkill)
        skillByCanonicalId.set(canonicalId, synced.skill)
        result.synchronized += 1
      }
    }

    for (const skill of skills) {
      if (deletedSkillIds.has(skill.id)) continue
      const canonicalWorkflowId = workflowIdFromSkillCanonicalId(skill.canonicalId)
      if (canonicalWorkflowId) {
        // Canonical identity wins over stale generated fields from the
        // pre-repair snapshot. This also recognizes orphan projections whose
        // `kind` drifted away from "workflow".
        if (!activePublishedIds.has(canonicalWorkflowId)) {
          await db.skills.delete(skill.id)
          result.removedSkills += 1
        }
        continue
      }
      if (skill.kind !== "workflow") continue
      const workflow = skill.workflowId ? workflowById.get(skill.workflowId) : undefined
      if (!workflow || !activePublishedIds.has(workflow.id)) {
        await db.skills.delete(skill.id)
        result.removedSkills += 1
      }
    }

    return result
  })
}

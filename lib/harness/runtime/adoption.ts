/**
 * Adopting an evolved harness, and rolling it back (ADR-0237).
 *
 * Every write goes through the shared configuration-apply mechanism
 * (`applyEvalRecommendation` / `rollbackEvalRecommendation`) with the target
 * type `agent-harness`: the previous projection is stored, and a rollback
 * refuses when the agent was edited since. The projection is what evolution
 * owns on an agent: its system prompt, its harness sections and its skill ids.
 *
 * Where the harness lands depends on the run's scope:
 *
 * | scope     | effect |
 * | --------- | ------ |
 * | task      | nothing outside the run; the chosen harness and its deliverable are the result |
 * | session   | an evolved variant gets the harness and the conversation switches to it |
 * | workspace | an evolved variant gets the harness; optionally the workspace's default agent |
 * | global    | the agent itself gets the harness |
 *
 * The evolved variant (ADR-0199) follows its base in everything evolution does
 * not touch. The same variant is reused by later adoptions from the same agent
 * (found through earlier runs, not by name).
 *
 * Skills are forked on write: an unchanged library skill keeps its id; a new
 * or edited one becomes an agent-owned library row keyed by its content
 * (`harness:<agent>:<key>:<hash>`), so a shared skill is never edited in place
 * and a rollback finds the old rows still there.
 */

import type { Character, Skill } from "@cognia/agent-config-types"
import type { EvalConfigurationApplyRow } from "@/lib/db/eval-lab"
import type { SkillDraft } from "@/lib/db/skills"
import type {
  EvalConfigurationApplicationDeps,
  EvalConfigurationTarget,
} from "@/lib/ai/eval/recommendation-application"
import type { HarnessEvolutionRun, HarnessRunAdoption } from "@/types/harness/evolution"
import type { HarnessSkillV1, HarnessSnapshotV1 } from "@/types/harness/snapshot"
import { canonicalHash } from "../snapshot"

export const HARNESS_APPLY_TARGET = "agent-harness" as const
const PROJECTION_KEYS = ["systemPrompt", "harness", "skillIds"] as const

export interface AdoptionDeps {
  resolveCharacter(id: string): Promise<Character | undefined>
  updateCharacter(
    id: string,
    patch: Partial<Omit<Character, "id" | "createdAt" | "isBuiltIn">>
  ): Promise<void>
  createCharacterVariant(baseId: string, name: string): Promise<Character>
  /** Earlier runs of an agent, to find the evolved variant they created. */
  listRuns(characterId: string): Promise<HarnessEvolutionRun[]>
  upsertSkill(input: { draft: SkillDraft; canonicalId: string }): Promise<{ skill: Skill }>
  saveApply(record: EvalConfigurationApplyRow): Promise<void>
  getApply(id: string): Promise<EvalConfigurationApplyRow | undefined>
  updateApply(id: string, patch: Partial<EvalConfigurationApplyRow>): Promise<void>
  getSessionCharacterId(sessionId: string): Promise<string | undefined>
  switchSessionAgent(sessionId: string, characterId: string): Promise<void>
  getWorkspaceDefaultAgent(projectId: string): Promise<string | null | undefined>
  setWorkspaceDefaultAgent(projectId: string, characterId: string | null): Promise<void>
  recordGovernance(input: {
    runId: string
    characterId: string
    targetCharacterId: string
    scope: string
    baseContentHash: string
    chosenContentHash: string
    chosenSnapshotId: string
    risk: string
    approvedBy: HarnessRunAdoption["approvedBy"]
    reason: string
    applyId?: string
    decidedAt: number
  }): Promise<string>
  recordRollbackGovernance(input: {
    runId: string
    targetCharacterId: string
    at: number
  }): Promise<void>
  now(): number
  newId(): string
}

/** The part of an agent evolution owns. */
export function harnessProjection(character: Character): Record<string, unknown> {
  const source = character as unknown as Record<string, unknown>
  return Object.fromEntries(
    PROJECTION_KEYS.map((key) => [
      key,
      source[key] === undefined ? null : structuredClone(source[key]),
    ])
  )
}

/** `applyEvalRecommendation` deps for the `agent-harness` target. */
export function harnessApplicationDeps(
  deps: Pick<
    AdoptionDeps,
    | "resolveCharacter"
    | "updateCharacter"
    | "saveApply"
    | "getApply"
    | "updateApply"
    | "now"
    | "newId"
  >
): EvalConfigurationApplicationDeps {
  return {
    async read(target: EvalConfigurationTarget) {
      if (target.targetType !== HARNESS_APPLY_TARGET) {
        throw new Error(`Not an agent-harness target: ${target.targetType}`)
      }
      const character = await deps.resolveCharacter(target.targetId)
      if (!character) throw new Error(`Agent ${target.targetId} not found`)
      return harnessProjection(character)
    },
    async write(target: EvalConfigurationTarget, value: Record<string, unknown>) {
      if (target.targetType !== HARNESS_APPLY_TARGET) {
        throw new Error(`Not an agent-harness target: ${target.targetType}`)
      }
      const patch: Partial<Character> = {}
      for (const key of PROJECTION_KEYS) {
        const v = value[key]
        ;(patch as Record<string, unknown>)[key] = v === null ? undefined : structuredClone(v)
      }
      await deps.updateCharacter(target.targetId, patch)
    },
    saveRecord: deps.saveApply,
    getRecord: deps.getApply,
    updateRecord: deps.updateApply,
    now: deps.now,
    newId: deps.newId,
  }
}

function sameSkill(a: HarnessSkillV1, b: HarnessSkillV1): boolean {
  const strip = (s: HarnessSkillV1) => ({
    key: s.key,
    name: s.name,
    description: s.description,
    content: s.content,
    allowedTools: s.allowedTools ?? [],
    resources: s.resources,
  })
  return JSON.stringify(strip(a)) === JSON.stringify(strip(b))
}

/** Library skill ids for a snapshot's skills, forking new or edited ones. */
export async function resolveSnapshotSkillIds(
  chosen: Pick<HarnessSnapshotV1, "components">,
  base: Pick<HarnessSnapshotV1, "components">,
  ownerId: string,
  deps: Pick<AdoptionDeps, "upsertSkill">
): Promise<string[]> {
  const baseByKey = new Map(base.components.skills.map((s) => [s.key, s]))
  const ids: string[] = []
  for (const skill of chosen.components.skills) {
    const before = baseByKey.get(skill.key)
    if (
      skill.sourceSkillId &&
      before?.sourceSkillId === skill.sourceSkillId &&
      sameSkill(before, skill)
    ) {
      ids.push(skill.sourceSkillId)
      continue
    }
    const hash = await canonicalHash({
      name: skill.name,
      description: skill.description,
      content: skill.content,
      allowedTools: skill.allowedTools ?? [],
      resources: skill.resources,
    })
    const { skill: row } = await deps.upsertSkill({
      canonicalId: `harness:${ownerId}:${skill.key}:${hash.slice(0, 12)}`,
      draft: {
        name: skill.name,
        slug: skill.key,
        description: skill.description,
        content: skill.content,
        ...(skill.allowedTools?.length ? { allowedTools: [...skill.allowedTools] } : {}),
        tags: ["harness-evolution"],
        source: "generated",
        category: "custom",
        status: "enabled",
        kind: "markdown",
        resources: skill.resources.map((r) => ({
          kind: r.kind,
          name: r.path.split("/").pop() ?? r.path,
          path: r.path,
          content: r.content,
          encoding: r.encoding ?? "utf-8",
          inline: false,
        })),
      },
    })
    ids.push(row.id)
  }
  return ids
}

export class HarnessAdoptionError extends Error {
  constructor(
    readonly code:
      | "no-decision"
      | "no-session"
      | "no-workspace"
      | "agent-changed"
      | "agent-not-found"
      | "not-adopted"
      | "already-rolled-back",
    message: string
  ) {
    super(message)
    this.name = "HarnessAdoptionError"
  }
}

/** The evolved variant earlier adoptions of this agent created, if it still exists. */
async function existingEvolvedVariant(
  run: HarnessEvolutionRun,
  deps: Pick<AdoptionDeps, "listRuns" | "resolveCharacter">
): Promise<Character | undefined> {
  const runs = await deps.listRuns(run.characterId)
  const ids = runs
    .filter((r) => r.id !== run.id && r.adoption?.variantCreated && r.adoption.targetCharacterId)
    .sort((a, b) => (b.adoption?.adoptedAt ?? 0) - (a.adoption?.adoptedAt ?? 0))
    .map((r) => r.adoption?.targetCharacterId as string)
  for (const id of new Set(ids)) {
    const variant = await deps.resolveCharacter(id)
    if (variant?.variant?.baseId === run.characterId) return variant
  }
  return undefined
}

export interface AdoptInput {
  run: HarnessEvolutionRun
  chosen: HarnessSnapshotV1
  base: HarnessSnapshotV1
  /** Skill ids of the agent outside the editable harness, kept as they are. */
  carriedSkillIds: readonly string[]
  approvedBy: HarnessRunAdoption["approvedBy"]
  /** Workspace scope: also make the evolved variant the workspace's default agent. */
  setAsWorkspaceDefault?: boolean
  /** The agent's harness content hash right now, to refuse adopting over unrelated edits. */
  currentContentHash: string
}

/** Write the chosen harness where the run's scope says. */
export async function adoptHarness(
  input: AdoptInput,
  deps: AdoptionDeps
): Promise<HarnessRunAdoption> {
  const { run, chosen, base } = input
  const decision = run.decision
  if (!decision || decision.outcome !== "adopt" || decision.chosenSnapshotId !== chosen.id) {
    throw new HarnessAdoptionError(
      "no-decision",
      "The run has no adoption decision for this harness."
    )
  }
  const now = deps.now()
  const scope = run.config.scope
  if (scope === "task") {
    return { scope, approvedBy: input.approvedBy, adoptedAt: now }
  }
  if (input.currentContentHash !== base.contentHash) {
    throw new HarnessAdoptionError(
      "agent-changed",
      "The agent was edited after this run started; its result was measured against a harness that no longer exists. Start a new run."
    )
  }
  const agent = await deps.resolveCharacter(run.characterId)
  if (!agent)
    throw new HarnessAdoptionError("agent-not-found", `Agent ${run.characterId} not found`)

  let target: Character = agent
  let variantCreated = false
  let previousCharacterId: string | undefined
  let previousWorkspaceDefaultId: string | null | undefined
  if (scope === "session") {
    if (!run.sessionId) {
      throw new HarnessAdoptionError(
        "no-session",
        "Session scope needs the conversation the run started from."
      )
    }
    previousCharacterId = await deps.getSessionCharacterId(run.sessionId)
    if (!previousCharacterId) {
      throw new HarnessAdoptionError(
        "no-session",
        "The conversation the run started from no longer exists or has no agent to replace."
      )
    }
  }
  if (scope === "workspace" && !run.projectId) {
    throw new HarnessAdoptionError(
      "no-workspace",
      "Workspace scope needs the workspace the run started in."
    )
  }
  if (scope === "session" || scope === "workspace") {
    const existing = await existingEvolvedVariant(run, deps)
    if (existing) {
      target = existing
    } else {
      target = await deps.createCharacterVariant(agent.id, `${agent.name} · evolved`)
      variantCreated = true
    }
  }

  const skillIds = [
    ...input.carriedSkillIds,
    ...(await resolveSnapshotSkillIds(chosen, base, target.id, deps)),
  ]
  const c = chosen.components
  const configuration: Record<string, unknown> = {
    systemPrompt: c.systemPrompt,
    harness: {
      guardrails: c.guardrails,
      memory: c.memory,
      toolGuidance: c.toolGuidance,
      subagents: c.subagents.map((s) => ({ ...s })),
      toolRules: c.toolRules.map((r) => ({ ...r })),
      adoptedSnapshotId: chosen.id,
    },
    skillIds,
  }
  const applicationDeps = harnessApplicationDeps(deps)
  const targetRef = { targetType: HARNESS_APPLY_TARGET, targetId: target.id } as const
  const { applyEvalRecommendation, previewConfigurationDiff } =
    await import("@/lib/ai/eval/recommendation-application")
  // The target may already carry exactly this harness (an earlier adoption of
  // the same result): nothing to write, and nothing for a rollback to undo.
  const unchanged =
    previewConfigurationDiff(await applicationDeps.read(targetRef), configuration).length === 0
  const applied = unchanged
    ? undefined
    : await applyEvalRecommendation(`harness:${run.id}`, targetRef, configuration, applicationDeps)

  if (scope === "session" && run.sessionId) {
    await deps.switchSessionAgent(run.sessionId, target.id)
  }
  let setAsWorkspaceDefault = false
  if (scope === "workspace" && input.setAsWorkspaceDefault && run.projectId) {
    previousWorkspaceDefaultId = (await deps.getWorkspaceDefaultAgent(run.projectId)) ?? null
    await deps.setWorkspaceDefaultAgent(run.projectId, target.id)
    setAsWorkspaceDefault = true
  }
  const decisionId = await deps.recordGovernance({
    runId: run.id,
    characterId: run.characterId,
    targetCharacterId: target.id,
    scope,
    baseContentHash: base.contentHash,
    chosenContentHash: chosen.contentHash,
    chosenSnapshotId: chosen.id,
    risk: decision.risk ?? "unknown",
    approvedBy: input.approvedBy,
    reason: decision.reason,
    ...(applied ? { applyId: applied.id } : {}),
    decidedAt: now,
  })
  return {
    scope,
    ...(applied ? { applyId: applied.id } : {}),
    targetCharacterId: target.id,
    ...(variantCreated ? { variantCreated } : {}),
    ...(setAsWorkspaceDefault
      ? { setAsWorkspaceDefault, previousWorkspaceDefaultId: previousWorkspaceDefaultId ?? null }
      : {}),
    ...(scope === "session" && run.sessionId
      ? { sessionId: run.sessionId, previousCharacterId }
      : {}),
    approvedBy: input.approvedBy,
    decisionId,
    adoptedAt: now,
  }
}

/** Undo an adoption. Refuses when the agent was edited since (the apply record says so). */
export async function rollbackHarnessAdoption(
  run: HarnessEvolutionRun,
  deps: AdoptionDeps
): Promise<HarnessRunAdoption> {
  const adoption = run.adoption
  if (!adoption) throw new HarnessAdoptionError("not-adopted", "This run adopted nothing.")
  if (adoption.rolledBackAt) {
    throw new HarnessAdoptionError("already-rolled-back", "This adoption was already rolled back.")
  }
  const now = deps.now()
  if (adoption.applyId) {
    const { rollbackEvalRecommendation } = await import("@/lib/ai/eval/recommendation-application")
    await rollbackEvalRecommendation(adoption.applyId, harnessApplicationDeps(deps))
  }
  if (adoption.sessionId && adoption.previousCharacterId) {
    await deps.switchSessionAgent(adoption.sessionId, adoption.previousCharacterId)
  }
  if (adoption.setAsWorkspaceDefault && run.projectId && adoption.targetCharacterId) {
    // Only undo the default if nobody changed it since.
    const current = await deps.getWorkspaceDefaultAgent(run.projectId)
    if (current === adoption.targetCharacterId) {
      await deps.setWorkspaceDefaultAgent(
        run.projectId,
        adoption.previousWorkspaceDefaultId ?? null
      )
    }
  }
  if (adoption.decisionId && adoption.targetCharacterId) {
    await deps.recordRollbackGovernance({
      runId: run.id,
      targetCharacterId: adoption.targetCharacterId,
      at: now,
    })
  }
  return { ...adoption, rolledBackAt: now }
}

/** Production dependencies. */
export async function defaultAdoptionDeps(): Promise<AdoptionDeps> {
  const [characters, store, skills, schema, sessions, governance, projects] = await Promise.all([
    import("@/lib/db/characters"),
    import("@/lib/db/harness-evolution"),
    import("@/lib/db/skills"),
    import("@/lib/db/schema"),
    import("@/lib/db/sessions"),
    import("@/lib/governance/producers/harness-adoption"),
    import("@/lib/db/projects"),
  ])
  const db = schema.getDb()
  return {
    resolveCharacter: characters.resolveCharacterById,
    updateCharacter: characters.updateCharacter,
    createCharacterVariant: characters.createCharacterVariant,
    listRuns: (characterId) => store.listHarnessRuns({ characterId, limit: 500 }),
    upsertSkill: ({ draft, canonicalId }) =>
      skills.upsertSkillByCanonicalId({ draft, canonicalId }),
    saveApply: async (record) => void (await db.evalConfigurationApplies.add(record)),
    getApply: (id) => db.evalConfigurationApplies.get(id),
    updateApply: async (id, patch) => void (await db.evalConfigurationApplies.update(id, patch)),
    getSessionCharacterId: async (sessionId) => {
      const session = await sessions.getSession(sessionId)
      return session?.characterId || undefined
    },
    switchSessionAgent: async (sessionId, characterId) => {
      await sessions.updateSession(sessionId, { characterId })
      // The open session list caches rows; keep it in step with the row.
      const { useSessionStore } = await import("@/stores/chat/session-store")
      useSessionStore.setState((state) => ({
        sessions: state.sessions.map((s) => (s.id === sessionId ? { ...s, characterId } : s)),
      }))
    },
    getWorkspaceDefaultAgent: async (projectId) => {
      const project = (await projects.getAllProjects()).find((p) => p.id === projectId)
      return project ? (project.defaultCharacterId ?? null) : undefined
    },
    setWorkspaceDefaultAgent: async (projectId, characterId) => {
      const { useProjectStore } = await import("@/stores/project/project-store")
      const loaded = useProjectStore.getState().projects.some((p) => p.id === projectId)
      if (loaded) {
        useProjectStore
          .getState()
          .updateProject(projectId, { defaultCharacterId: characterId ?? undefined })
        return
      }
      const project = (await projects.getAllProjects()).find((p) => p.id === projectId)
      if (!project)
        throw new HarnessAdoptionError("no-workspace", `Workspace ${projectId} not found`)
      await projects.putProject({ ...project, defaultCharacterId: characterId ?? undefined })
    },
    recordGovernance: governance.recordHarnessAdoptionGovernance,
    recordRollbackGovernance: governance.recordHarnessRollbackGovernance,
    now: Date.now,
    newId: () => crypto.randomUUID(),
  }
}

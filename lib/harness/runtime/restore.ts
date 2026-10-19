/**
 * Bring an earlier harness version of an agent back (ADR-0237).
 *
 * Version history lists every harness an agent had: captures, candidates,
 * adoptions. A person may pick one and restore it. The write goes through the
 * same configuration-apply record an adoption uses, so it can be undone, and
 * is recorded as a person's decision. The restored harness becomes a new
 * `restored` snapshot whose parent is the harness it replaced; the chosen
 * version itself is never modified.
 *
 * A restore only rewrites the harness fields (instructions, guardrails,
 * memory, tool guidance, subagents, tool rules, editable skills). The agent's
 * model, permissions, tools and MCP servers stay as they are now, so a
 * restore can never widen what the agent may do.
 */

import type { HarnessSnapshotV1 } from "@/types/harness/snapshot"
import { assessHarnessRisk, type HarnessRiskAssessment } from "../risk"
import { diffHarness, forkHarnessSnapshot } from "../snapshot"
import {
  HARNESS_APPLY_TARGET,
  HarnessAdoptionError,
  harnessApplicationDeps,
  harnessConfiguration,
  resolveSnapshotSkillIds,
  type AdoptionDeps,
} from "./adoption"
import type { CapturedHarness } from "./capture"

export interface RestoreDeps {
  adoption: AdoptionDeps
  capture(characterId: string): Promise<CapturedHarness>
  getSnapshot(id: string): Promise<HarnessSnapshotV1 | undefined>
  putSnapshot(snapshot: HarnessSnapshotV1): Promise<void>
  recordGovernance(input: {
    restoredSnapshotId: string
    sourceSnapshotId: string
    characterId: string
    currentContentHash: string
    restoredContentHash: string
    risk: string
    applyId?: string
    decidedAt: number
  }): Promise<string>
}

export class HarnessRestoreError extends Error {
  constructor(
    readonly code: "not-found" | "other-agent" | "unchanged" | "agent-changed",
    message: string
  ) {
    super(message)
    this.name = "HarnessRestoreError"
  }
}

export interface RestorePreview {
  current: HarnessSnapshotV1
  target: HarnessSnapshotV1
  /** What restoring would change, read the way an adoption's risk is read. */
  risk: HarnessRiskAssessment
  unchanged: boolean
  /** Skill ids the agent has outside its editable harness; a restore keeps them. */
  carriedSkillIds: string[]
}

async function loadTarget(
  characterId: string,
  snapshotId: string,
  deps: Pick<RestoreDeps, "getSnapshot">
): Promise<HarnessSnapshotV1> {
  const target = await deps.getSnapshot(snapshotId)
  if (!target) throw new HarnessRestoreError("not-found", "That harness version no longer exists.")
  if (target.characterId !== characterId) {
    throw new HarnessRestoreError(
      "other-agent",
      "That harness version belongs to another agent and cannot be restored here."
    )
  }
  return target
}

/** The current harness, the chosen version, and the risk of going back to it. */
export async function previewHarnessRestore(
  characterId: string,
  snapshotId: string,
  deps: Pick<RestoreDeps, "capture" | "getSnapshot">
): Promise<RestorePreview> {
  const target = await loadTarget(characterId, snapshotId, deps)
  const { snapshot: current, carriedSkillIds } = await deps.capture(characterId)
  const diff = diffHarness(current, { components: target.components, execution: current.execution })
  return {
    current,
    target,
    risk: assessHarnessRisk(current.components, target.components, diff),
    unchanged: diff.changes.length === 0,
    carriedSkillIds,
  }
}

export interface RestoreResult {
  restored: HarnessSnapshotV1
  /** Configuration-apply record; rolling it back undoes the restore. */
  applyId?: string
  decisionId: string
}

/**
 * Restore `snapshotId` onto its agent. `expectedContentHash` is the current
 * harness the person reviewed; a different one means the agent changed under
 * the confirmation and the restore is refused.
 */
export async function restoreHarnessVersion(
  input: { characterId: string; snapshotId: string; expectedContentHash: string },
  deps: RestoreDeps
): Promise<RestoreResult> {
  const preview = await previewHarnessRestore(input.characterId, input.snapshotId, deps)
  const { current, target } = preview
  if (current.contentHash !== input.expectedContentHash) {
    throw new HarnessRestoreError(
      "agent-changed",
      "The agent changed after you opened this version. Review the difference again."
    )
  }
  if (preview.unchanged) {
    throw new HarnessRestoreError("unchanged", "The agent already has this harness.")
  }
  const agent = await deps.adoption.resolveCharacter(input.characterId)
  if (!agent) {
    throw new HarnessAdoptionError("agent-not-found", `Agent ${input.characterId} not found`)
  }
  const now = deps.adoption.now()
  const restored = await forkHarnessSnapshot(current, {
    id: deps.adoption.newId(),
    components: target.components,
    origin: { kind: "restored", ...(target.origin.label ? { label: target.origin.label } : {}) },
    createdAt: now,
  })
  // The fork carries the current execution config, so its content hash is
  // the one a capture after the write produces.
  const skillIds = [
    ...preview.carriedSkillIds,
    ...(await resolveSnapshotSkillIds(restored, current, agent.id, deps.adoption)),
  ]
  const configuration = harnessConfiguration(restored, skillIds)
  const applicationDeps = harnessApplicationDeps(deps.adoption)
  const { applyEvalRecommendation } = await import("@/lib/ai/eval/recommendation-application")
  await deps.putSnapshot(restored)
  const applied = await applyEvalRecommendation(
    `harness-restore:${restored.id}`,
    { targetType: HARNESS_APPLY_TARGET, targetId: agent.id },
    configuration,
    applicationDeps
  )
  const decisionId = await deps.recordGovernance({
    restoredSnapshotId: restored.id,
    sourceSnapshotId: target.id,
    characterId: agent.id,
    currentContentHash: current.contentHash,
    restoredContentHash: restored.contentHash,
    risk: preview.risk.risk,
    applyId: applied.id,
    decidedAt: now,
  })
  return { restored, applyId: applied.id, decisionId }
}

/** Production dependencies. */
export async function defaultRestoreDeps(): Promise<RestoreDeps> {
  const [adoption, capture, store, governance] = await Promise.all([
    import("./adoption"),
    import("./capture"),
    import("@/lib/db/harness-evolution"),
    import("@/lib/governance/producers/harness-adoption"),
  ])
  const [adoptionDeps, captureDeps] = await Promise.all([
    adoption.defaultAdoptionDeps(),
    capture.defaultCaptureDeps(),
  ])
  return {
    adoption: adoptionDeps,
    capture: (characterId) => capture.captureHarness(characterId, { scope: "global" }, captureDeps),
    getSnapshot: store.getHarnessSnapshot,
    putSnapshot: store.putHarnessSnapshot,
    recordGovernance: governance.recordHarnessRestoreGovernance,
  }
}

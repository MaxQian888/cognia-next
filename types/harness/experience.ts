/**
 * The Harness Evolution experience library (ADR-0237).
 *
 * An experience records why a harness change helped (or did not) and when it
 * is worth trying again. It is an input to later editors, never applied
 * automatically, and never written to the Memory subsystem: agent-produced
 * lessons must not become trusted memory on their own (OWASP ASI06).
 */

import type { HarnessComponentName } from "./snapshot"

/** Who can retrieve an experience. */
export type HarnessExperienceScope = "agent" | "workspace" | "global"

export const HARNESS_EXPERIENCE_SCOPES: readonly HarnessExperienceScope[] = [
  "agent",
  "workspace",
  "global",
]

export type HarnessExperienceStatus = "proposed" | "verified" | "rejected" | "deprecated"

export const HARNESS_EXPERIENCE_STATUSES: readonly HarnessExperienceStatus[] = [
  "proposed",
  "verified",
  "rejected",
  "deprecated",
]

/** Edit attribution verdicts, as Harness²'s reflector defines them. */
export type HarnessEditVerdict = "helped" | "hurt" | "no observed effect" | "confounded"

export const HARNESS_EDIT_VERDICTS: readonly HarnessEditVerdict[] = [
  "helped",
  "hurt",
  "no observed effect",
  "confounded",
]

/** What one component change did, attributed from the trajectories. */
export interface HarnessEditAttribution {
  /** Editable-tree path or component name the row is about. */
  component: string
  /** Stage labels that carried this edit. */
  candidates: string[]
  change: string
  observed: string
  verdict: HarnessEditVerdict
}

export type HarnessExperienceConfidence = "high" | "medium" | "low"

export interface HarnessExperience {
  id: string
  scope: HarnessExperienceScope
  /** Agent the lesson came from; agent-scoped entries are visible to it (and its variants) only. */
  characterId: string
  projectId?: string
  domain: string
  /** The shape of situation the lesson applies to (Harness² `cue`). */
  problemPattern: string
  /** The harness operation to perform, naming the component (Harness² `lesson`). */
  lesson: string
  /** The edit rows and execution contrast it rests on (Harness² `evidence`). */
  evidenceSummary: string
  confidence: HarnessExperienceConfidence
  confidenceReason?: string
  applicableConditions: string[]
  excludedConditions: string[]
  /** Components the lesson concerns. */
  components: HarnessComponentName[]
  edits: HarnessEditAttribution[]
  baseSnapshotId: string
  adoptedSnapshotId?: string
  /** Run and step ids the evidence lives in. */
  evidenceRefs: string[]
  sourceRunId: string
  changeSummary: string
  observedBenefits: string[]
  knownLimitations: string[]
  validationStatus: HarnessExperienceStatus
  /** Runtime fingerprint of the run that produced it; a mismatch marks it stale. */
  runtimeFingerprint: string
  /** Model family the evidence was produced with, for retrieval. */
  modelFamily?: string
  /** Tool names and failure kinds seen in the evidence, for structured retrieval. */
  tags: string[]
  /** Runs that merged into this entry as near-duplicates. */
  supportRunIds: string[]
  /** Experiences flagged as contradicting this one (opposite verdict, same component, same domain). */
  conflictsWith: string[]
  /** Later runs that retrieved this entry, and the verdicts their reflections gave it. */
  retrievedCount: number
  helpedCount: number
  hurtCount: number
  disabled: boolean
  createdAt: number
  updatedAt: number
  lastValidatedAt?: number
}

/** A retrieved entry with the reasons it ranked where it did. */
export interface HarnessExperienceMatch {
  experience: HarnessExperience
  score: number
  stale: boolean
  reasons: string[]
}

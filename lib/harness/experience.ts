/**
 * The experience library's rules (ADR-0237): building an entry from a
 * reflection, merging near-duplicates, flagging contradictions, retrieving
 * relevant entries for a new run, updating standing from later runs, and
 * choosing what to evict.
 *
 * Pure functions; `lib/db/harness-evolution.ts` stores the rows. An entry is
 * an input to editors, never applied by itself, and never written into the
 * Memory subsystem.
 *
 * Lifecycle: an entry starts `proposed`, or `verified` when the run adopted a
 * harness that carried an edit the reflection found helpful. Later runs that
 * were given it report whether it helped; one report of help with none of
 * harm verifies it, repeated harm rejects it. `deprecated` is set by a person
 * or when an entry is superseded; stale entries (another runtime) rank lower
 * and say so.
 */

import { tokenizeMultilingual } from "@cognia/rag/cjk-tokenizer"
import { BM25Index } from "@cognia/rag/hybrid-search"
import type { HarnessEvolutionRun } from "@/types/harness/evolution"
import type {
  HarnessEditAttribution,
  HarnessExperience,
  HarnessExperienceConfidence,
  HarnessExperienceMatch,
  HarnessExperienceScope,
  HarnessExperienceStatus,
} from "@/types/harness/experience"
import type { HarnessComponentName } from "@/types/harness/snapshot"
import { HARNESS_COMPONENT_NAMES } from "@/types/harness/snapshot"
import { componentsOfEdit, type ProposedExperience, type RetrievedVerdict } from "./reflect"

/** Similarity at which two lessons are the same lesson. */
export const DUPLICATE_SIMILARITY = 0.6
/** Similarity of situations at which opposite lessons contradict each other. */
export const CONFLICT_SIMILARITY = 0.35
/** Entries handed to one editor stage. */
export const DEFAULT_RETRIEVAL_LIMIT = 5
const MAX_REFS = 20
const MAX_EDITS = 40
const MAX_LIST = 12

const STOPWORDS = new Set(
  "the and for with that this from into when then than are was were has have had not but use uses using its it's onto over each any all can may must should will would a an of to in on at by or as is be".split(
    " "
  )
)

/**
 * Lower-case content terms, for overlap measures. The shared multilingual
 * tokenizer splits CJK text into bigrams, so Chinese lessons match too.
 */
export function contentTokens(text: string): Set<string> {
  return new Set(
    tokenizeMultilingual(text).filter(
      (w) => !STOPWORDS.has(w) && (w.length >= 3 || /[^\x00-\x7f]/.test(w))
    )
  )
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0
  let shared = 0
  for (const t of a) if (b.has(t)) shared++
  return shared / (a.size + b.size - shared)
}

/** Whether the lesson is to do something (helped) or to avoid something (hurt). */
export type ExperiencePolarity = "positive" | "negative" | "mixed"

export function polarityOf(edits: readonly HarnessEditAttribution[]): ExperiencePolarity {
  const helped = edits.some((e) => e.verdict === "helped")
  const hurt = edits.some((e) => e.verdict === "hurt")
  return helped && !hurt ? "positive" : hurt && !helped ? "negative" : "mixed"
}

function componentsOf(
  edits: readonly HarnessEditAttribution[],
  lesson: string
): HarnessComponentName[] {
  const set = new Set<HarnessComponentName>()
  for (const e of edits) {
    if (e.verdict === "helped" || e.verdict === "hurt") {
      for (const c of componentsOfEdit(e.component)) set.add(c)
    }
  }
  if (set.size === 0) {
    const lower = lesson.toLowerCase()
    for (const name of HARNESS_COMPONENT_NAMES)
      if (lower.includes(name.toLowerCase())) set.add(name)
  }
  return HARNESS_COMPONENT_NAMES.filter((c) => set.has(c))
}

const CONFIDENCE_RANK: Record<HarnessExperienceConfidence, number> = { low: 0, medium: 1, high: 2 }

function uniq<T>(items: Iterable<T>, max: number): T[] {
  return [...new Set(items)].slice(0, max)
}

export interface ExperienceFromReflectionInput {
  id: string
  now: number
  run: Pick<
    HarnessEvolutionRun,
    "id" | "characterId" | "projectId" | "task" | "decision" | "baseSnapshotId"
  >
  scope: HarnessExperienceScope
  proposed: ProposedExperience
  edits: readonly HarnessEditAttribution[]
  runtimeFingerprint: string
  modelFamily?: string
  /** Step ids the evidence lives in. */
  evidenceRefs: readonly string[]
  /**
   * Whether the decision's harness is already in effect. A decision waiting
   * for approval has not been adopted yet; {@link markExperienceAdopted}
   * verifies the lesson once it is.
   */
  adopted: boolean
}

/** Where a run's lessons are visible: its adoption scope, narrowed to what the run can vouch for. */
export function experienceScopeFor(
  run: Pick<HarnessEvolutionRun, "projectId" | "config">
): HarnessExperienceScope {
  if (run.config.scope === "global") return "global"
  if (run.config.scope === "workspace" && run.projectId) return "workspace"
  return "agent"
}

export function experienceFromReflection(input: ExperienceFromReflectionInput): HarnessExperience {
  const { run, proposed, edits } = input
  const decision = run.decision
  const adoptedHelped =
    input.adopted &&
    decision?.outcome === "adopt" &&
    !!decision.chosenLabel &&
    edits.some(
      (e) => e.verdict === "helped" && e.candidates.includes(decision.chosenLabel as string)
    )
  const effective = edits.filter((e) => e.verdict === "helped" || e.verdict === "hurt")
  return {
    id: input.id,
    scope: input.scope,
    characterId: run.characterId,
    ...(run.projectId ? { projectId: run.projectId } : {}),
    domain: run.task.domain,
    problemPattern: proposed.cue,
    lesson: proposed.lesson,
    evidenceSummary: proposed.evidence,
    confidence: proposed.confidence,
    applicableConditions: [...proposed.appliesWhen],
    excludedConditions: [...proposed.notWhen],
    components: componentsOf(edits, proposed.lesson),
    edits: edits.slice(0, MAX_EDITS).map((e) => ({ ...e, candidates: [...e.candidates] })),
    baseSnapshotId: run.baseSnapshotId ?? "",
    ...(decision?.outcome === "adopt" && decision.chosenSnapshotId
      ? { adoptedSnapshotId: decision.chosenSnapshotId }
      : {}),
    evidenceRefs: uniq(input.evidenceRefs, MAX_REFS),
    sourceRunId: run.id,
    changeSummary: effective.map((e) => `${e.component}: ${e.change} (${e.verdict})`).join("\n"),
    observedBenefits: uniq(
      edits
        .filter((e) => e.verdict === "helped")
        .map((e) => e.observed)
        .filter(Boolean),
      MAX_LIST
    ),
    knownLimitations: uniq(
      [
        ...proposed.notWhen,
        ...edits
          .filter((e) => e.verdict === "hurt")
          .map((e) => e.observed)
          .filter(Boolean),
      ],
      MAX_LIST
    ),
    validationStatus: adoptedHelped ? "verified" : "proposed",
    runtimeFingerprint: input.runtimeFingerprint,
    ...(input.modelFamily ? { modelFamily: input.modelFamily } : {}),
    tags: [...proposed.tags],
    supportRunIds: [run.id],
    conflictsWith: [],
    retrievedCount: 0,
    helpedCount: 0,
    hurtCount: 0,
    disabled: false,
    createdAt: input.now,
    updatedAt: input.now,
    ...(adoptedHelped ? { lastValidatedAt: input.now } : {}),
  }
}

/**
 * An entry after its run's harness was adopted: verified when an edit the
 * chosen harness carried helped, and linked to the adopted snapshot either way.
 */
export function markExperienceAdopted(
  experience: HarnessExperience,
  adopted: { chosenLabel: string; chosenSnapshotId: string },
  now: number
): HarnessExperience {
  const carriedHelp = experience.edits.some(
    (e) => e.verdict === "helped" && e.candidates.includes(adopted.chosenLabel)
  )
  const status =
    carriedHelp && experience.validationStatus === "proposed"
      ? "verified"
      : experience.validationStatus
  return {
    ...experience,
    adoptedSnapshotId: adopted.chosenSnapshotId,
    validationStatus: status,
    updatedAt: now,
    ...(status === "verified" && experience.validationStatus !== "verified"
      ? { lastValidatedAt: now }
      : {}),
  }
}

/** Whether an entry with `scope` from `owner` is visible to a run of `characterId` in `projectId`. */
export function isVisibleTo(
  experience: Pick<HarnessExperience, "scope" | "characterId" | "projectId">,
  query: { characterIds: readonly string[]; projectId?: string }
): boolean {
  switch (experience.scope) {
    case "global":
      return true
    case "workspace":
      return !!query.projectId && experience.projectId === query.projectId
    case "agent":
      return query.characterIds.includes(experience.characterId)
  }
}

function sameAudience(a: HarnessExperience, b: HarnessExperience): boolean {
  if (a.scope !== b.scope) return false
  if (a.scope === "agent") return a.characterId === b.characterId
  if (a.scope === "workspace") return a.projectId === b.projectId
  return true
}

function overlaps<T>(a: readonly T[], b: readonly T[]): boolean {
  return a.some((x) => b.includes(x))
}

/** An existing entry that says the same thing, to merge into instead of adding. */
export function findDuplicate(
  incoming: HarnessExperience,
  existing: readonly HarnessExperience[]
): HarnessExperience | undefined {
  const tokens = contentTokens(`${incoming.problemPattern} ${incoming.lesson}`)
  const polarity = polarityOf(incoming.edits)
  let best: { entry: HarnessExperience; score: number } | undefined
  for (const entry of existing) {
    if (entry.id === incoming.id || entry.validationStatus === "rejected") continue
    if (!sameAudience(entry, incoming) || entry.domain !== incoming.domain) continue
    if (
      entry.components.length &&
      incoming.components.length &&
      !overlaps(entry.components, incoming.components)
    ) {
      continue
    }
    if (polarityOf(entry.edits) !== polarity) continue
    const score = jaccard(tokens, contentTokens(`${entry.problemPattern} ${entry.lesson}`))
    if (score >= DUPLICATE_SIMILARITY && (!best || score > best.score)) best = { entry, score }
  }
  return best?.entry
}

/** Merge a new run's version of a lesson into the entry it duplicates. */
export function mergeExperience(
  existing: HarnessExperience,
  incoming: HarnessExperience,
  now: number
): HarnessExperience {
  const verified =
    existing.validationStatus === "verified" || incoming.validationStatus === "verified"
  const status: HarnessExperienceStatus =
    existing.validationStatus === "deprecated"
      ? "deprecated"
      : verified
        ? "verified"
        : existing.validationStatus
  return {
    ...existing,
    confidence:
      CONFIDENCE_RANK[incoming.confidence] > CONFIDENCE_RANK[existing.confidence]
        ? incoming.confidence
        : existing.confidence,
    evidenceSummary: `${existing.evidenceSummary}\n${incoming.evidenceSummary}`.slice(-4_000),
    applicableConditions: uniq(
      [...existing.applicableConditions, ...incoming.applicableConditions],
      MAX_LIST
    ),
    excludedConditions: uniq(
      [...existing.excludedConditions, ...incoming.excludedConditions],
      MAX_LIST
    ),
    components: HARNESS_COMPONENT_NAMES.filter(
      (c) => existing.components.includes(c) || incoming.components.includes(c)
    ),
    edits: [...existing.edits, ...incoming.edits].slice(-MAX_EDITS),
    evidenceRefs: uniq([...existing.evidenceRefs, ...incoming.evidenceRefs], MAX_REFS),
    observedBenefits: uniq([...existing.observedBenefits, ...incoming.observedBenefits], MAX_LIST),
    knownLimitations: uniq([...existing.knownLimitations, ...incoming.knownLimitations], MAX_LIST),
    tags: uniq([...existing.tags, ...incoming.tags], MAX_LIST * 2),
    supportRunIds: uniq([...existing.supportRunIds, incoming.sourceRunId], MAX_REFS),
    runtimeFingerprint: incoming.runtimeFingerprint,
    ...(incoming.modelFamily ? { modelFamily: incoming.modelFamily } : {}),
    ...(incoming.adoptedSnapshotId ? { adoptedSnapshotId: incoming.adoptedSnapshotId } : {}),
    validationStatus: status,
    updatedAt: now,
    ...(incoming.validationStatus === "verified" ? { lastValidatedAt: now } : {}),
  }
}

/** Entries that contradict `incoming`: same situation and component, opposite effect. */
export function findConflicts(
  incoming: HarnessExperience,
  existing: readonly HarnessExperience[]
): string[] {
  const polarity = polarityOf(incoming.edits)
  if (polarity === "mixed") return []
  const tokens = contentTokens(incoming.problemPattern)
  return existing
    .filter(
      (entry) =>
        entry.id !== incoming.id &&
        entry.domain === incoming.domain &&
        overlaps(entry.components, incoming.components) &&
        polarityOf(entry.edits) !== "mixed" &&
        polarityOf(entry.edits) !== polarity &&
        jaccard(tokens, contentTokens(entry.problemPattern)) >= CONFLICT_SIMILARITY
    )
    .map((entry) => entry.id)
}

/** Standing after a later run's verdict on an entry it was given. */
export function applyRetrievedVerdict(
  experience: HarnessExperience,
  verdict: RetrievedVerdict["verdict"],
  now: number
): HarnessExperience {
  const helpedCount = experience.helpedCount + (verdict === "helped" ? 1 : 0)
  const hurtCount = experience.hurtCount + (verdict === "hurt" ? 1 : 0)
  return {
    ...experience,
    helpedCount,
    hurtCount,
    validationStatus: lifecycleStatus({ ...experience, helpedCount, hurtCount }),
    updatedAt: now,
    ...(verdict === "helped" ? { lastValidatedAt: now } : {}),
  }
}

/** The status the counts imply. A person's `deprecated` (and a rejection) is never undone here. */
export function lifecycleStatus(
  experience: Pick<HarnessExperience, "validationStatus" | "helpedCount" | "hurtCount">
): HarnessExperienceStatus {
  const { validationStatus: status, helpedCount, hurtCount } = experience
  if (status === "deprecated" || status === "rejected") return status
  if (hurtCount >= 2 && hurtCount > helpedCount) return "rejected"
  if (status === "verified") return hurtCount > helpedCount ? "proposed" : "verified"
  return helpedCount >= 1 && hurtCount === 0 ? "verified" : status
}

export interface RetrievalQuery {
  /** The agent and its variant base, whose agent-scoped entries apply. */
  characterIds: readonly string[]
  projectId?: string
  domain: string
  /** Text of the task: title and prompt. */
  taskText: string
  /** Components the editors may change; entries about other components are useless. */
  editable: readonly HarnessComponentName[]
  runtimeFingerprint: string
  limit?: number
}

function domainScore(entry: string, query: string): number {
  if (entry === query) return 3
  if (entry.startsWith(`${query}/`) || query.startsWith(`${entry}/`)) return 2
  return entry.split("/")[0] === query.split("/")[0] ? 1 : 0
}

/** The entries most worth showing a run's editors, best first. */
export function retrieveExperiences(
  entries: readonly HarnessExperience[],
  query: RetrievalQuery
): HarnessExperienceMatch[] {
  const taskTokens = contentTokens(query.taskText)
  // BM25 over each entry's situation, lesson, conditions and tags, queried
  // with the task text; normalised to the best hit so scores compare across runs.
  const index = new BM25Index()
  for (const entry of entries) {
    index.addDocument(
      entry.id,
      [entry.problemPattern, entry.lesson, ...entry.applicableConditions, ...entry.tags].join("\n")
    )
  }
  const bm25 = new Map(index.search(query.taskText, entries.length).map((h) => [h.id, h.score]))
  const topBm25 = Math.max(0, ...bm25.values())
  const matches: HarnessExperienceMatch[] = []
  for (const entry of entries) {
    if (entry.disabled) continue
    if (entry.validationStatus === "rejected" || entry.validationStatus === "deprecated") continue
    if (!isVisibleTo(entry, query)) continue
    if (entry.components.length && !overlaps(entry.components, query.editable)) continue
    const reasons: string[] = []
    let score = 0
    const domain = domainScore(entry.domain, query.domain)
    if (domain === 0) continue
    score += domain
    reasons.push(domain === 3 ? "same domain" : "related domain")
    const relevance = topBm25 > 0 ? (bm25.get(entry.id) ?? 0) / topBm25 : 0
    if (relevance > 0) {
      score += 3 * relevance
      reasons.push(`text match ${relevance.toFixed(2)}`)
    }
    if (entry.excludedConditions.some((c) => jaccard(taskTokens, contentTokens(c)) >= 0.5)) {
      score -= 2
      reasons.push("matches an excluded condition")
    }
    if (entry.validationStatus === "verified") {
      score += 2
      reasons.push("verified")
    }
    score += CONFIDENCE_RANK[entry.confidence] * 0.5
    const net = entry.helpedCount - entry.hurtCount
    if (net !== 0) {
      score += Math.max(-2, Math.min(2, net * 0.5))
      reasons.push(`helped ${entry.helpedCount}, hurt ${entry.hurtCount}`)
    }
    const stale = entry.runtimeFingerprint !== query.runtimeFingerprint
    if (stale) {
      score -= 1
      reasons.push("recorded on another runtime")
    }
    if (entry.conflictsWith.length) reasons.push(`contradicted by ${entry.conflictsWith.length}`)
    matches.push({ experience: entry, score, stale, reasons })
  }
  return matches
    .sort((a, b) => b.score - a.score || b.experience.updatedAt - a.experience.updatedAt)
    .slice(0, query.limit ?? DEFAULT_RETRIEVAL_LIMIT)
}

/**
 * Ids to delete so an agent keeps at most `cap` entries: rejected and
 * deprecated first, then disabled, then the weakest proposed, oldest first.
 * Verified entries go last.
 */
export function evictionCandidates(entries: readonly HarnessExperience[], cap: number): string[] {
  if (entries.length <= cap) return []
  const rank = (e: HarnessExperience): number =>
    e.validationStatus === "rejected" || e.validationStatus === "deprecated"
      ? 0
      : e.disabled
        ? 1
        : e.validationStatus === "proposed"
          ? 2
          : 3
  return [...entries]
    .sort(
      (a, b) =>
        rank(a) - rank(b) ||
        a.helpedCount - a.hurtCount - (b.helpedCount - b.hurtCount) ||
        CONFIDENCE_RANK[a.confidence] - CONFIDENCE_RANK[b.confidence] ||
        a.updatedAt - b.updatedAt
    )
    .slice(0, entries.length - cap)
    .map((e) => e.id)
}

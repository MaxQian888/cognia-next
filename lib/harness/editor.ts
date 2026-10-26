/**
 * Editor proposals: parse, apply, validate, retry once (ADR-0237).
 *
 * Whatever channel an editor ran on, its answer becomes an {@link EditProposal}:
 * a decision, notes, and the harness files it changed. The proposal is applied
 * to the input harness's tree, parsed back into components and validated.
 *
 * Harness²'s contract for an invalid proposal is kept exactly: the validator's
 * messages go back to the same editor once, verbatim; a second invalid answer
 * makes the stage inherit its input harness and records that it fell back.
 * Keeping the harness unchanged is a valid answer, not a failure.
 */

import type { HarnessComponentName, HarnessComponentsV1 } from "@/types/harness/snapshot"
import { extractEmbeddedJsonObject } from "./checks"
import { diffHarness } from "./snapshot"
import {
  componentsToTree,
  diffTrees,
  normalizeHarnessPath,
  treeToComponents,
  type HarnessTree,
} from "./tree"
import { validateHarnessCandidate, type HarnessValidationReport } from "./validate"

export interface EditProposal {
  decision: "edit" | "keep_base"
  notes: string
  /** Path (relative to `harness/`) → new content, or `null` to delete. */
  files: Record<string, string | null>
}

export type ParseProposalResult =
  { ok: true; proposal: EditProposal } | { ok: false; error: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Read a structured editor's JSON answer. */
export function parseStructuredProposal(text: string): ParseProposalResult {
  const value = extractEmbeddedJsonObject(text)
  if (!isRecord(value)) {
    return { ok: false, error: "the answer is not one JSON object with decision, notes and files" }
  }
  const decision = value.decision
  if (decision !== "edit" && decision !== "keep_base") {
    return { ok: false, error: 'decision must be "edit" or "keep_base"' }
  }
  const notes = typeof value.notes === "string" ? value.notes : ""
  const rawFiles = value.files ?? {}
  if (!isRecord(rawFiles)) return { ok: false, error: "files must be an object of path → content" }
  const files: Record<string, string | null> = {}
  for (const [path, content] of Object.entries(rawFiles)) {
    if (content !== null && typeof content !== "string") {
      return { ok: false, error: `files["${path}"] must be a string or null` }
    }
    files[path.replace(/^harness\//, "")] = content
  }
  return { ok: true, proposal: { decision, notes, files } }
}

/**
 * The proposal an agentic editor made by editing files: its notes file decides
 * keep-base, and the file changes are read off the before/after trees.
 */
export function proposalFromEditedTree(
  before: HarnessTree,
  after: HarnessTree,
  notes: string
): EditProposal {
  const first = notes.trim().split("\n")[0]?.trim().toUpperCase() ?? ""
  const diff = diffTrees(before, after)
  const files: Record<string, string | null> = {}
  for (const p of [...diff.added, ...diff.modified]) files[p] = after[p]
  for (const p of diff.removed) files[p] = null
  const keep = first.startsWith("KEEP_BASE") || Object.keys(files).length === 0
  return { decision: keep ? "keep_base" : "edit", notes, files: keep ? {} : files }
}

/** Apply a proposal's file changes to a tree. Escaping paths are reported, not applied. */
export function applyProposal(
  base: HarnessTree,
  files: Record<string, string | null>
): { tree: HarnessTree; escapingPaths: string[] } {
  const tree: HarnessTree = { ...base }
  const escapingPaths: string[] = []
  for (const [raw, content] of Object.entries(files)) {
    let path: string
    try {
      path = normalizeHarnessPath(raw)
    } catch {
      escapingPaths.push(raw)
      continue
    }
    if (content === null) delete tree[path]
    else tree[path] = content
  }
  return { tree, escapingPaths }
}

export interface ProposalPolicy {
  editable: readonly HarnessComponentName[]
  knownTools?: readonly string[]
}

export type ProposalEvaluation =
  | { kind: "keep-base"; components: HarnessComponentsV1 }
  | { kind: "valid"; components: HarnessComponentsV1; report: HarnessValidationReport }
  | { kind: "invalid"; errors: string[] }

/** Turn a proposal into a candidate harness, or the errors that stop it. */
export function evaluateProposal(
  proposal: EditProposal,
  current: HarnessComponentsV1,
  policy: ProposalPolicy
): ProposalEvaluation {
  if (proposal.decision === "keep_base") return { kind: "keep-base", components: current }
  const { tree, escapingPaths } = applyProposal(componentsToTree(current), proposal.files)
  const parsed = treeToComponents(tree, current)
  const errors = [
    ...escapingPaths.map((p) => `${p}: paths must stay inside harness/`),
    ...parsed.rejectedPaths.map(
      (p) => `${p}: not part of the editable harness (see RULES.md for the files you may write)`
    ),
    ...parsed.errors,
  ]
  if (errors.length) return { kind: "invalid", errors }
  const diff = diffHarness(
    { components: current, execution: {} },
    { components: parsed.components, execution: {} }
  )
  if (diff.changes.length === 0) return { kind: "keep-base", components: current }
  const report = validateHarnessCandidate(parsed.components, current, policy)
  if (!report.ok) return { kind: "invalid", errors: report.errors }
  return { kind: "valid", components: parsed.components, report }
}

export type EditorAttempt = (
  retryErrors: readonly string[] | undefined
) => Promise<{ ok: true; proposal: EditProposal } | { ok: false; error: string }>

export interface EditorStageResult {
  outcome: "changed" | "kept" | "fell-back"
  components: HarnessComponentsV1
  notes: string
  attempts: number
  /** Errors of the last rejected attempt, when there was one. */
  errors: string[]
}

/**
 * Run one editor stage under the retry-once contract. `attempt` performs one
 * editor session; a thrown error (provider failure, abort) propagates, because
 * it is not a proposal and must not be confused with an invalid one.
 */
export async function runEditorStage(
  current: HarnessComponentsV1,
  policy: ProposalPolicy,
  attempt: EditorAttempt
): Promise<EditorStageResult> {
  let retryErrors: string[] | undefined
  let lastNotes = ""
  for (let n = 1; n <= 2; n++) {
    const answer = await attempt(retryErrors)
    if (!answer.ok) {
      retryErrors = [answer.error]
      continue
    }
    lastNotes = answer.proposal.notes
    const evaluation = evaluateProposal(answer.proposal, current, policy)
    if (evaluation.kind === "keep-base") {
      return { outcome: "kept", components: current, notes: lastNotes, attempts: n, errors: [] }
    }
    if (evaluation.kind === "valid") {
      return {
        outcome: "changed",
        components: evaluation.components,
        notes: lastNotes,
        attempts: n,
        errors: [],
      }
    }
    retryErrors = evaluation.errors
  }
  return {
    outcome: "fell-back",
    components: current,
    notes: lastNotes,
    attempts: 2,
    errors: retryErrors ?? [],
  }
}

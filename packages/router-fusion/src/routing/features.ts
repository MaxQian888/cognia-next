/**
 * Trusted feature extraction (DESIGN §5.2, §7.1, ROUTE-04).
 *
 * Numbers and states the runtime already knows — failed attempts, the source
 * revision, which verifications exist, whether the classifier input was cut —
 * come from the runtime snapshot, never from a model. The user's text is
 * untrusted input: it is budgeted to the classifier token cap, and when the
 * cut removes content the classifier needed, the task is `unknown` rather than
 * a confident cheap route.
 */

import {
  CONTRACT_SCHEMA_VERSION,
  type Phase,
  type RoutingFeatures,
  type TaskKind,
} from "../contracts/schemas"

export const FEATURE_VERSION = "features-1"

export interface RoutingSnapshot {
  /** Untrusted user text for this turn. */
  userText: string
  /** Program-owned constraints (task contract, workspace rules); always kept whole. */
  trustedConstraints: string[]
  phase: Phase
  failedAttempts: number
  verificationKinds: string[]
  sourceRevision: string | null
  /** BCP-47-ish hint from the host; derived from the text when absent. */
  language?: string
  /** Fields the runtime knows are missing (e.g. an unauthorized workspace for a code task). */
  missingInformation: string[]
}

export interface ClassifierLabels {
  task: TaskKind
  ambiguity: RoutingFeatures["ambiguity"]
  tool_need: RoutingFeatures["tool_need"]
  scope: RoutingFeatures["scope"]
  missing_information: string[]
  goal: string
}

export interface ClassifierInput {
  text: string
  truncated: boolean
  estimatedTokens: number
}

const CJK = /[぀-ヿ㐀-䶿一-鿿가-힯豈-﫿]/

/**
 * Conservative token estimate: one token per CJK character, one per four
 * other characters. It over-counts rather than under-counts, so the cap errs
 * toward truncation.
 */
export function estimateTokens(text: string): number {
  let cjk = 0
  let other = 0
  for (const char of text) {
    if (CJK.test(char)) cjk++
    else other++
  }
  return cjk + Math.ceil(other / 4)
}

function takeTokens(text: string, budget: number): string {
  if (budget <= 0) return ""
  let used = 0
  let otherRun = 0
  let out = ""
  for (const char of text) {
    const cost = CJK.test(char) ? 1 : (otherRun + 1) % 4 === 1 ? 1 : 0
    if (!CJK.test(char)) otherRun++
    if (used + cost > budget) break
    used += cost
    out += char
  }
  return out
}

/**
 * Build the classifier input under `tokenCap`. Trusted constraints and the
 * phase/failure header are placed first and never cut; only the user text is
 * trimmed, from the end.
 */
export function buildClassifierInput(snapshot: RoutingSnapshot, tokenCap: number): ClassifierInput {
  const header = [
    `phase: ${snapshot.phase}`,
    `failed_attempts: ${snapshot.failedAttempts}`,
    ...snapshot.trustedConstraints.map((c) => `constraint: ${c}`),
  ].join("\n")
  const headerTokens = estimateTokens(header)
  const remaining = tokenCap - headerTokens - 2
  const fullTokens = estimateTokens(snapshot.userText)
  if (fullTokens <= remaining) {
    return {
      text: `${header}\n\n${snapshot.userText}`,
      truncated: false,
      estimatedTokens: headerTokens + fullTokens + 2,
    }
  }
  const kept = takeTokens(snapshot.userText, Math.max(0, remaining))
  return {
    text: `${header}\n\n${kept}`,
    truncated: true,
    estimatedTokens: headerTokens + estimateTokens(kept) + 2,
  }
}

export function detectLanguage(text: string): string {
  let cjk = 0
  let latin = 0
  for (const char of text) {
    if (CJK.test(char)) cjk++
    else if (/[a-z]/i.test(char)) latin++
  }
  if (cjk === 0 && latin === 0) return "und"
  return cjk >= latin / 3 ? "zh" : "en"
}

/**
 * Merge classifier labels with the runtime's trusted facts. A truncated input
 * whose classification still reports missing information falls back to
 * `unknown` so a cut prompt can never earn an aggressive route.
 */
export function extractFeatures(
  snapshot: RoutingSnapshot,
  labels: ClassifierLabels,
  input: ClassifierInput
): RoutingFeatures {
  const missing = [...new Set([...snapshot.missingInformation, ...labels.missing_information])]
  const truncatedIncomplete = input.truncated && (missing.length > 0 || labels.ambiguity !== "low")
  return {
    schema_version: CONTRACT_SCHEMA_VERSION,
    goal: labels.goal,
    task: truncatedIncomplete ? "unknown" : labels.task,
    phase: snapshot.phase,
    language: snapshot.language ?? detectLanguage(snapshot.userText),
    missing_information:
      truncatedIncomplete && missing.length === 0 ? ["context_truncated"] : missing,
    ambiguity: truncatedIncomplete ? "unknown" : labels.ambiguity,
    tool_need: labels.tool_need,
    scope: truncatedIncomplete ? "unknown" : labels.scope,
    failed_attempts: snapshot.failedAttempts,
    verification_kinds: [...snapshot.verificationKinds],
    source_revision: snapshot.sourceRevision,
    feature_version: FEATURE_VERSION,
    context_truncated: input.truncated,
  }
}

/**
 * Trusted feature extraction (DESIGN §5.2, §7.1, ROUTE-04).
 *
 * Numbers and states the runtime already knows — failed attempts, the source
 * revision, which verifications exist, whether the classifier input was cut —
 * come from the runtime snapshot, never from a model. The user's text is
 * untrusted input: it is budgeted to the classifier token cap, and when the
 * cut removes content the classifier needed, the task is `unknown` rather than
 * a confident cheap route.
 *
 * The opt-in LLM classifier (D18, B5) reads the same budgeted input. Its reply
 * is the classification subset of RoutingFeatures and nothing else
 * (`ClassifierOutputSchema`, strict); `labelsFromClassifierOutput` turns it into
 * labels, and `extractFeatures` merges those with the trusted facts exactly as
 * it does for the rules classifier.
 */

import { z } from "zod"

import {
  CONTRACT_SCHEMA_VERSION,
  PHASES,
  RoutingFeaturesSchema,
  TASK_KINDS,
  type Phase,
  type RoutingFeatures,
  type TaskKind,
} from "../contracts/schemas"
import { systemPromptFor } from "../prompts/roles"
import { untrustedBlock } from "../workflows/prompting"

export const FEATURE_VERSION = "features-1"

/** Input cap of every classification, rules or model (DESIGN §7.1, ROUTE-04, D18). */
export const CLASSIFIER_INPUT_TOKEN_CAP = 4096

/**
 * Version of the LLM classifier: the spec's classifier prompt (`classifier-1`)
 * and the output contract below. A RouteDecision whose labels came from the
 * model carries it as `classifier_version`; a rules fallback carries the rules
 * classifier's version instead.
 */
export const LLM_CLASSIFIER_VERSION = "classifier-1"

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
  /** The routing context and the kept user text, as one classifiable text. */
  text: string
  truncated: boolean
  estimatedTokens: number
  /** The trusted part: phase, failed attempts and constraints; never cut. */
  routingContext: string
  /** The untrusted part: the user text as far as the cap allowed. */
  userText: string
}

/**
 * The snapshot of a request that arrives with nothing but its text: a chat
 * turn, a Run API request's first classification, a difficulty-judge prompt.
 * No attempt failed yet, no revision exists and nothing is known to be missing.
 */
export function intakeSnapshot(
  userText: string,
  options: { trustedConstraints?: string[]; verificationKinds?: string[] } = {}
): RoutingSnapshot {
  return {
    userText,
    trustedConstraints: [...(options.trustedConstraints ?? [])],
    phase: "intake",
    failedAttempts: 0,
    verificationKinds: [...(options.verificationKinds ?? [])],
    sourceRevision: null,
    missingInformation: [],
  }
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
      routingContext: header,
      userText: snapshot.userText,
    }
  }
  const kept = takeTokens(snapshot.userText, Math.max(0, remaining))
  return {
    text: `${header}\n\n${kept}`,
    truncated: true,
    estimatedTokens: headerTokens + estimateTokens(kept) + 2,
    routingContext: header,
    userText: kept,
  }
}

// ── the LLM classifier's contract (D18, ROUTE-03) ─────────────────────────────

/**
 * What the classifier model may answer: the classification subset of
 * RoutingFeatures that the spec prompt names (`01_classifier.md`: task, phase,
 * missing information, ambiguity, tool need, scope) plus a one-sentence goal.
 * Strict, like every contract object: a reply that adds a field — a success
 * probability, a model choice, a rewritten trusted fact — is invalid as a
 * whole, never half-trusted.
 */
export const ClassifierOutputSchema = z.strictObject({
  task: RoutingFeaturesSchema.shape.task,
  phase: RoutingFeaturesSchema.shape.phase.optional(),
  missing_information: z.array(z.string().trim().min(1).max(200)).max(16),
  ambiguity: RoutingFeaturesSchema.shape.ambiguity,
  tool_need: RoutingFeaturesSchema.shape.tool_need,
  scope: RoutingFeaturesSchema.shape.scope,
  goal: z.string().max(2_000).optional(),
})
export type ClassifierOutput = z.infer<typeof ClassifierOutputSchema>

export type ClassifierReplyParse =
  { ok: true; output: ClassifierOutput } | { ok: false; reason: "invalid_json" | "schema_invalid" }

/**
 * Parse a classifier reply strictly: one JSON object, validated by the schema.
 * The prompt forbids code fences, but a reply wrapped in exactly one ```json
 * fence is read as the JSON inside it — the fence carries no content, and
 * discarding a paid answer over it would only waste the call. Prose around the
 * object, a second object or trailing text is invalid.
 */
export function parseClassifierReply(text: string): ClassifierReplyParse {
  const trimmed = text.trim()
  const fenced = /^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n?```$/i.exec(trimmed)
  const body = fenced ? fenced[1].trim() : trimmed
  let value: unknown
  try {
    value = JSON.parse(body)
  } catch {
    return { ok: false, reason: "invalid_json" }
  }
  const parsed = ClassifierOutputSchema.safeParse(value)
  return parsed.success
    ? { ok: true, output: parsed.data }
    : { ok: false, reason: "schema_invalid" }
}

/** Weakest to strongest; `unknown` says the least. */
const TOOL_NEED_RANK: Record<ClassifierLabels["tool_need"], number> = {
  unknown: -1,
  none: 0,
  read_only: 1,
  sandbox_write: 2,
  external_write: 3,
}

function shortGoal(goal: string): string {
  const oneLine = goal.trim().replace(/\s+/g, " ")
  return oneLine.length > 200 ? `${oneLine.slice(0, 200)}…` : oneLine
}

/**
 * Labels from a validated classifier reply. The model decides the task,
 * ambiguity and scope; two things it cannot lower:
 *
 * - the tool need the rules classifier found — a capability requirement a
 *   keyword proved (a write action, a code change) is a floor, so a reply that
 *   says "none" cannot route a deploy request to a tool-less model;
 * - missing information the rules classifier found — more missing information
 *   only ever makes a route more careful.
 *
 * The phase stays the runtime's (`extractFeatures` takes it from the snapshot):
 * it is a fact of where the work is, not a reading of the text.
 */
export function labelsFromClassifierOutput(
  output: ClassifierOutput,
  floor: ClassifierLabels
): ClassifierLabels {
  const toolNeed =
    TOOL_NEED_RANK[output.tool_need] >= TOOL_NEED_RANK[floor.tool_need]
      ? output.tool_need
      : floor.tool_need
  const goal = output.goal ? shortGoal(output.goal) : ""
  return {
    task: output.task,
    ambiguity: output.ambiguity,
    tool_need: toolNeed,
    scope: output.scope,
    missing_information: [
      ...new Set([
        ...output.missing_information.map((item) => item.trim()),
        ...floor.missing_information,
      ]),
    ],
    goal: goal.length > 0 ? goal : floor.goal,
  }
}

/** The output contract, spelled out for the model (the prompt's `taxonomy` slot). */
export const CLASSIFIER_TAXONOMY = [
  "Reply with exactly one JSON object and nothing else. Fields:",
  `- "task": one of ${TASK_KINDS.join(", ")}`,
  '- "ambiguity": one of low, medium, high, unknown',
  '- "tool_need": one of none, read_only, sandbox_write, external_write, unknown',
  '- "scope": one of single_item, single_file, multi_file, cross_system, unknown',
  '- "missing_information": an array of short strings; empty when nothing is missing',
  '- "goal": optional; one sentence saying what the user wants',
  `- "phase": optional; one of ${PHASES.join(", ")}`,
  "Any other field makes the reply invalid.",
].join("\n")

/** Room for the rounding of per-part token estimates, so the whole request stays under the cap. */
const CLASSIFIER_PROMPT_MARGIN = 16

export interface ClassifierPrompt {
  system: string
  /** The user message: routing context, taxonomy and the fenced user text. */
  prompt: string
  /** What was classified; `truncated` says whether the user text was cut. */
  input: ClassifierInput
  /** System plus user message, by the same conservative estimate as the cap. */
  estimatedTokens: number
  /**
   * The trusted part alone does not fit under the cap. The request is not sent:
   * trusted constraints are never cut (ROUTE-04), so the model could not see
   * them all.
   */
  overCap: boolean
}

function renderClassifierPrompt(input: Pick<ClassifierInput, "routingContext" | "userText">) {
  return [
    "routing_context:",
    input.routingContext,
    "",
    "taxonomy:",
    CLASSIFIER_TAXONOMY,
    "",
    untrustedBlock("user_text", input.userText),
  ].join("\n")
}

/**
 * The classifier request for a snapshot, whole request (system prompt
 * included) under `tokenCap`. Only the user text is cut, from the end, and the
 * cut is deterministic: the same snapshot always yields the same request.
 */
export function buildClassifierPrompt(
  snapshot: RoutingSnapshot,
  tokenCap: number = CLASSIFIER_INPUT_TOKEN_CAP
): ClassifierPrompt {
  const system = systemPromptFor("classifier")
  const systemTokens = estimateTokens(system)
  const frameTokens = estimateTokens(renderClassifierPrompt({ routingContext: "", userText: "" }))
  let budget = Math.max(0, tokenCap - systemTokens - frameTokens - CLASSIFIER_PROMPT_MARGIN)
  for (;;) {
    const input = buildClassifierInput(snapshot, budget)
    const prompt = renderClassifierPrompt(input)
    const estimatedTokens = systemTokens + estimateTokens(prompt)
    // The budget shrinks by at least one token per round, so this ends.
    if (estimatedTokens <= tokenCap || budget === 0) {
      return { system, prompt, input, estimatedTokens, overCap: estimatedTokens > tokenCap }
    }
    budget = Math.max(0, budget - (estimatedTokens - tokenCap))
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

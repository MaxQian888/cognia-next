/**
 * The reply copilot's orchestration (ADR-0194), in Jarvis's order:
 *
 *   judge (7 typed questions) ∥ draft (3 candidates on the utility model)
 *   → rank (one `best_reply` choice over the drafts, on the same judge).
 *
 * Every stage fails on its own: a missing decision provider leaves the judge
 * `unavailable` and the drafts unranked, a failed draft still shows the
 * judgment. Nothing here sends anything — the UI fills the composer at most.
 *
 * Dormancy (Rule 7): with no provider selected the judge outcome is the typed
 * `{ kind: "unavailable", reason: "no_provider" }`, which the panel labels as
 * such; `run-copilot.test.ts` pins it.
 *
 * Validation gate: a provider judges and ranks only if it lists
 * `COPILOT_QUESTION_SET` in `validatedQuestionSets` (the built-in endpoint does
 * for its Jev presets, which Jarvis calibrated; a custom URL is unknown). Laya
 * zero-shot measured at chance on this set (intent 17–23%, danger MAE 2.2 vs
 * Jarvis's ≥60% / <1.0 bar), so with laya selected the judge is
 * `{ kind: "unavailable", reason: "not_validated" }` and drafts stay unranked.
 */

import { runDecision, type RunDecisionOptions } from "@/lib/decisions/run-decision"
import { getDecisionRegistry } from "@/lib/decisions/host-registry"
import { loadDecisionSettings } from "@/lib/decisions/config"
import { BUILTIN_HTTP_PROVIDER_ID } from "@/lib/decisions/providers/decisions-http"
import type { LlmClient } from "@/lib/twin/distill/llm"
import {
  COPILOT_STATE_TRIM,
  isSidedTranscript,
  toCopilotState,
  type CopilotTranscript,
} from "@/lib/reply-copilot/build-state"
import { draftCandidates, type DraftCandidatesResult } from "@/lib/reply-copilot/draft-candidates"
import {
  isEmptyJudgment,
  rankCandidates,
  toJudgment,
  type CopilotJudgment,
  type RankedCandidate,
} from "@/lib/reply-copilot/judgment"
import type { CopilotKnowledge } from "@/lib/reply-copilot/knowledge"
import {
  COPILOT_QUESTION_SET,
  chooseQuestionVariant,
  judgeQuestions,
  rankQuestion,
  type QuestionVariant,
} from "@/lib/reply-copilot/questions"
import type {
  DecisionErrorKind,
  DecisionProviderLimits,
  DecisionRequest,
  DecisionResult,
} from "@/types/decisions"

/** Relationship the judge sees when the user never described the contact. */
export const UNSPECIFIED_RELATIONSHIP = "unspecified"

/** Kinds that mean "no judge here", not "the judge broke". */
const UNAVAILABLE_KINDS: ReadonlySet<DecisionErrorKind> = new Set([
  "no_provider",
  "provider_unavailable",
  "not_configured",
  "cors_unreachable",
])

/**
 * Why the copilot did not judge: a decision error, a provider not validated for
 * this set, or a transcript whose senders could not all be told apart (a
 * screen read, ADR-0194 §8).
 */
export type CopilotUnavailableReason = DecisionErrorKind | "not_validated" | "unsided"

export type JudgeOutcome =
  | {
      kind: "ok"
      judgment: CopilotJudgment
      providerId: string
      latencyMs: number
      /** Laya cut instructions / options or the state; the read may be degraded. */
      truncated: boolean
      /** The background was rejected by a strict endpoint and dropped. */
      backgroundDropped: boolean
    }
  | { kind: "unavailable"; reason: CopilotUnavailableReason }
  | { kind: "failed"; reason: DecisionErrorKind }

export type DraftOutcome =
  | {
      kind: "ok"
      candidates: RankedCandidate[]
      /** False when ranking was not possible; `rankError` / `rankSkipped` say why. */
      ranked: boolean
      rankError?: DecisionErrorKind
      rankSkipped?: "no_provider" | "not_validated" | "single_candidate" | "unsided"
    }
  | { kind: "skipped"; reason: "pii" | "empty" | "no-output" | "no-model" }
  | { kind: "failed" }

export interface CopilotResult {
  judge: JudgeOutcome
  drafts: DraftOutcome
  variant: QuestionVariant
}

export interface CopilotRunInput {
  transcript: CopilotTranscript
  knowledge: CopilotKnowledge
  instructions: string
  /** Drafting model; `null` when no utility model resolves (drafts skip). */
  client: LlmClient | null
  signal?: AbortSignal
}

export interface CopilotRunDeps {
  decide: (request: DecisionRequest, options: RunDecisionOptions) => Promise<DecisionResult>
  draft: (input: Parameters<typeof draftCandidates>[0]) => Promise<DraftCandidatesResult>
  /** The selected provider, or null when none is selected / installed. */
  selectedProvider: () => Promise<SelectedCopilotProvider | null>
}

export interface SelectedCopilotProvider {
  id: string
  limits?: DecisionProviderLimits
  /** Measured and passed on `COPILOT_QUESTION_SET`. */
  validated: boolean
}

const defaultDeps: CopilotRunDeps = {
  decide: (request, options) => runDecision(request, options),
  draft: draftCandidates,
  selectedProvider: async () => {
    const settings = await loadDecisionSettings()
    const id = settings.providerId
    if (!id) return null
    const provider = getDecisionRegistry().get(id)
    if (!provider) return null
    // The built-in endpoint's presets are the Jev models Jarvis calibrated this
    // set on; a custom URL could be anything.
    const validated =
      id === BUILTIN_HTTP_PROVIDER_ID
        ? Boolean(settings.http?.preset && settings.http.preset !== "custom")
        : (provider.validatedQuestionSets ?? []).includes(COPILOT_QUESTION_SET)
    return { id, validated, ...(provider.limits ? { limits: provider.limits } : {}) }
  },
}

function outcomeOfFailure(kind: DecisionErrorKind): JudgeOutcome {
  return UNAVAILABLE_KINDS.has(kind)
    ? { kind: "unavailable", reason: kind }
    : { kind: "failed", reason: kind }
}

function isStrictRejection(result: DecisionResult): boolean {
  return (
    !result.ok &&
    result.error.kind === "http_status" &&
    result.error.status !== undefined &&
    result.error.status >= 400 &&
    result.error.status < 500
  )
}

export async function runCopilot(
  input: CopilotRunInput,
  deps: CopilotRunDeps = defaultDeps
): Promise<CopilotResult> {
  input.signal?.throwIfAborted()
  const provider = await deps.selectedProvider()
  const variant = chooseQuestionVariant(provider?.limits)
  const relationship = input.knowledge.relationship || UNSPECIFIED_RELATIONSHIP
  const background = input.knowledge.background
  const decideOptions: RunDecisionOptions = {
    ...(provider ? { providerId: provider.id } : {}),
    ...(input.signal ? { signal: input.signal } : {}),
  }

  /**
   * One decision with the background, retried once without it when a strict
   * endpoint rejects the unknown field (Jarvis's defensive retry).
   */
  async function decideWithBackground(
    questions: DecisionRequest["questions"]
  ): Promise<{ result: DecisionResult; backgroundDropped: boolean }> {
    const request = (withBackground: boolean): DecisionRequest => ({
      state: toCopilotState(
        input.transcript,
        relationship,
        withBackground ? background : undefined
      ),
      questions,
      stateTrim: COPILOT_STATE_TRIM,
    })
    const first = await deps.decide(request(true), decideOptions)
    if (background && isStrictRejection(first)) {
      return { result: await deps.decide(request(false), decideOptions), backgroundDropped: true }
    }
    return { result: first, backgroundDropped: false }
  }

  const sided = isSidedTranscript(input.transcript)
  const judgeReady = sided && provider?.validated === true
  const judgePromise: Promise<JudgeOutcome> = !sided
    ? Promise.resolve({ kind: "unavailable", reason: "unsided" })
    : !provider
      ? Promise.resolve({ kind: "unavailable", reason: "no_provider" })
      : !judgeReady
        ? Promise.resolve({ kind: "unavailable", reason: "not_validated" })
        : decideWithBackground(judgeQuestions(variant)).then(({ result, backgroundDropped }) => {
            if (!result.ok) return outcomeOfFailure(result.error.kind)
            const judgment = toJudgment(result.answers)
            if (isEmptyJudgment(judgment)) return { kind: "failed", reason: "provider_error" }
            return {
              kind: "ok",
              judgment,
              providerId: result.providerId,
              latencyMs: result.latencyMs,
              truncated: Boolean(result.truncation || result.stateTruncated),
              backgroundDropped,
            }
          })

  type DraftAttempt =
    DraftCandidatesResult | { kind: "failed" } | { kind: "skipped"; reason: "no-model" }
  const draftPromise: Promise<DraftAttempt> = input.client
    ? deps
        .draft({
          transcript: input.transcript,
          relationship: input.knowledge.relationship,
          background,
          instructions: input.instructions,
          client: input.client,
          ...(input.signal ? { signal: input.signal } : {}),
        })
        .catch((error: unknown): DraftAttempt => {
          if (input.signal?.aborted) throw error
          return { kind: "failed" }
        })
    : Promise.resolve<DraftAttempt>({ kind: "skipped", reason: "no-model" })

  const [judge, drafted] = await Promise.all([judgePromise, draftPromise])
  input.signal?.throwIfAborted()

  let drafts: DraftOutcome
  if (drafted.kind !== "drafts") {
    drafts =
      drafted.kind === "failed" ? { kind: "failed" } : { kind: "skipped", reason: drafted.reason }
  } else if (!provider || !judgeReady || drafted.candidates.length < 2) {
    drafts = {
      kind: "ok",
      candidates: rankCandidates(drafted.candidates, null),
      ranked: false,
      rankSkipped: !sided
        ? "unsided"
        : !provider
          ? "no_provider"
          : !judgeReady
            ? "not_validated"
            : "single_candidate",
    }
  } else {
    const { result } = await decideWithBackground(rankQuestion(drafted.candidates, variant))
    drafts = result.ok
      ? {
          kind: "ok",
          candidates: rankCandidates(drafted.candidates, result.answers),
          ranked: result.answers.best_reply !== undefined,
        }
      : {
          kind: "ok",
          candidates: rankCandidates(drafted.candidates, null),
          ranked: false,
          rankError: result.error.kind,
        }
  }
  return { judge, drafts, variant }
}

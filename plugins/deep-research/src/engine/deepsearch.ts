/**
 * DeepSearch orchestrator — the iterative search→read→reason→answer loop.
 *
 * Pure in spirit (à la `lib/goal/turn-driver`): all I/O is injected via
 * `EngineDeps`, so the whole loop is unit-testable with mocked ai/search/read.
 * The loop accumulates evidence into a bounded IterResearch workspace and
 * self-evaluates answers (separate evaluator) before returning. Budget-forcing
 * + beast mode guarantee termination with a best-effort answer.
 */
import { unwrapUntrustedContent } from "@cognia/plugin-sdk"

import type { DeepSearchConfig, DeepSearchResult, EngineDeps } from "../types"
import { DEFAULT_CONFIG } from "../types"
import { decideNextAction, type ActionDecision } from "./actions"
import { draftAnswer } from "./answer"
import { beastReason, shouldForceAnswer } from "./budget"
import { evaluateAnswer } from "./evaluate"
import { runReadStep } from "./read-step"
import { runSearchStep } from "./search-step"
import {
  appendReportNote,
  initState,
  MAX_GAP_QUEUE,
  recordStep,
  renderEvidence,
  type ResearchState,
} from "./workspace"

export async function runDeepSearch(
  question: string,
  deps: EngineDeps,
  configOverride?: Partial<DeepSearchConfig>
): Promise<DeepSearchResult> {
  const config: DeepSearchConfig = { ...DEFAULT_CONFIG, ...configOverride }
  const state = initState(question, config)
  deps.reportProgress?.(0, "Planning research…")

  while (true) {
    if (deps.signal?.aborted) {
      return abortResult(state, deps)
    }
    state.step += 1
    if (shouldForceAnswer(state)) {
      return finalize(state, deps, beastReason(state))
    }

    const { decision, tokens } = await decideNextAction(state, deps.ai, deps.signal)
    state.tokensUsed += tokens
    deps.reportProgress?.(progress(state), describe(decision))

    if (decision.action === "search") {
      const { added, tokens: t } = await runSearchStep(decision.queries, state, deps)
      state.tokensUsed += t
      recordStep(state, "search", `${decision.queries.join(" · ")} → +${added.length} source(s)`)
      state.allowAnswer = true
    } else if (decision.action === "read") {
      const { added, tokens: t } = await runReadStep(decision.urls, state, deps, config.readTopK)
      state.tokensUsed += t
      for (const k of added) appendReportNote(state, `${k.title}: ${k.content.slice(0, 200)}`)
      recordStep(state, "read", `read ${added.length} new source(s)`)
      state.allowAnswer = true
    } else if (decision.action === "reflect") {
      let pushed = 0
      for (const gap of decision.gaps) {
        const key = gap.trim().toLowerCase()
        const known = state.gapQueue.some((g) => g.trim().toLowerCase() === key)
        if (!known && state.gapQueue.length < MAX_GAP_QUEUE) {
          state.gapQueue.push(gap)
          pushed += 1
        }
      }
      recordStep(state, "reflect", `+${pushed} sub-question(s)`)
    } else {
      const accepted = await tryAnswer(state, deps)
      if (accepted) return accepted
    }
  }
}

/** Draft + evaluate an answer. Returns the result on pass; bumps bad-attempt state on fail. */
async function tryAnswer(state: ResearchState, deps: EngineDeps): Promise<DeepSearchResult | null> {
  const { answer, citations, tokens } = await draftAnswer(state, deps.ai, false)
  state.tokensUsed += tokens
  const { evaluation, tokens: evalTokens } = await evaluateAnswer(
    state.question,
    answer,
    renderEvidence(state),
    deps.ai,
    state.config.locale,
    deps.signal
  )
  state.tokensUsed += evalTokens

  if (evaluation.pass) {
    recordStep(state, "answer", "accepted")
    deps.reportProgress?.(1, "Done")
    return {
      answer,
      citations,
      knowledge: state.knowledge,
      steps: state.steps,
      usage: { totalTokens: state.tokensUsed },
      gaveUp: false,
    }
  }

  state.badAttempts += 1
  state.allowAnswer = false
  recordStep(
    state,
    "answer",
    `rejected: ${evaluation.reasons.join("; ") || "insufficient grounding"}`
  )
  return null
}

/**
 * Cancellation: return what was gathered WITHOUT one last model call — a user
 * who hit Stop does not want to wait for (or pay for) a beast-mode draft.
 */
function abortResult(state: ResearchState, deps: EngineDeps): DeepSearchResult {
  recordStep(state, "answer", "aborted")
  deps.reportProgress?.(1, "Cancelled")
  return {
    answer: state.evolvingReport
      ? `Research was cancelled. Findings gathered so far:\n\n${state.evolvingReport}`
      : "Research was cancelled before an answer could be drafted.",
    citations: state.knowledge.map((k) => ({
      url: k.url,
      title: unwrapUntrustedContent(k.title),
      ...(k.publishedDate ? { publishedDate: k.publishedDate } : {}),
    })),
    knowledge: state.knowledge,
    steps: state.steps,
    usage: { totalTokens: state.tokensUsed },
    gaveUp: true,
    aborted: true,
  }
}

/** Beast mode: force the best possible answer from current evidence and return. */
async function finalize(
  state: ResearchState,
  deps: EngineDeps,
  reason: string
): Promise<DeepSearchResult> {
  const { answer, citations, tokens } = await draftAnswer(state, deps.ai, true)
  state.tokensUsed += tokens
  recordStep(state, "answer", `forced (${reason})`)
  deps.reportProgress?.(1, "Done")
  return {
    answer,
    citations,
    knowledge: state.knowledge,
    steps: state.steps,
    usage: { totalTokens: state.tokensUsed },
    gaveUp: true,
  }
}

function progress(state: ResearchState): number {
  return Math.min(0.95, state.step / state.config.maxSteps)
}

function describe(decision: ActionDecision): string {
  switch (decision.action) {
    case "search":
      return `🔍 Searching: ${decision.queries.join(", ").slice(0, 80)}`
    case "read":
      return `📖 Reading ${decision.urls.length} source(s)`
    case "reflect":
      return `🤔 Refining: ${decision.gaps.join("; ").slice(0, 80)}`
    case "answer":
      return "✍️ Drafting answer"
  }
}

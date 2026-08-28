/**
 * Action selection — the controller step. Asks the model for the next move and
 * normalises its (possibly messy) JSON into a safe `ActionDecision`. Falls back
 * to a deterministic heuristic when the model output can't be parsed, so the
 * loop never wedges on a bad response.
 */
import type { AiBridge } from "../lib/ai"
import { completeJson } from "../lib/ai"
import { extractJson } from "../lib/json"
import type { ResearchAction } from "../types"
import { canAnswer } from "./budget"
import { decideActionMessages } from "./prompts"
import { renderWorkspace, type ResearchState } from "./workspace"

export interface ActionDecision {
  action: ResearchAction
  queries: string[]
  urls: string[]
  gaps: string[]
  rationale?: string
}

interface RawDecision {
  action?: unknown
  queries?: unknown
  urls?: unknown
  gaps?: unknown
  rationale?: unknown
}

export async function decideNextAction(
  state: ResearchState,
  ai: AiBridge
): Promise<{ decision: ActionDecision; tokens: number }> {
  const allowAnswer = canAnswer(state)
  const messages = decideActionMessages(renderWorkspace(state), allowAnswer, state.config.locale)

  try {
    const res = await completeJson<RawDecision>(ai, messages, (t) => extractJson<RawDecision>(t), {
      temperature: 0.2,
      maxTokens: 600,
    })
    return { decision: normalizeDecision(res.value, state, allowAnswer), tokens: res.tokens }
  } catch {
    return { decision: heuristicDecision(state, allowAnswer), tokens: 0 }
  }
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((v): v is string => typeof v === "string" && v.trim().length > 0)
    .map((v) => v.trim())
}

/** Validate + repair the model's decision so the loop always gets a usable move. */
export function normalizeDecision(
  raw: RawDecision,
  state: ResearchState,
  allowAnswer: boolean
): ActionDecision {
  let action = (typeof raw.action === "string" ? raw.action.toLowerCase() : "") as ResearchAction
  const queries = asStringArray(raw.queries)
  const urls = asStringArray(raw.urls).filter((u) => state.candidates.some((c) => c.url === u))
  const gaps = asStringArray(raw.gaps)
  const rationale = typeof raw.rationale === "string" ? raw.rationale : undefined
  // `exactOptionalPropertyTypes`: an absent rationale must be an ABSENT key, not
  // a present `undefined`. Plugin authors compile against the packed SDK with
  // that flag on, so this file has to hold under it too.
  const maybeRationale = rationale === undefined ? {} : { rationale }

  const valid: ResearchAction[] = ["search", "read", "reflect", "answer"]
  if (!valid.includes(action)) action = heuristicDecision(state, allowAnswer).action

  // Budget-forcing: never answer when disallowed.
  if (action === "answer" && !allowAnswer) {
    action = state.candidates.length > 0 ? "read" : "search"
  }
  // Repair missing payloads so the chosen action can actually run.
  if (action === "search" && queries.length === 0) {
    queries.push(nextGap(state))
  }
  if (action === "read" && urls.length === 0) {
    if (state.candidates.length === 0) {
      // Nothing to read — pivot to search.
      return {
        action: "search",
        queries: [nextGap(state)],
        urls: [],
        gaps: [],
        ...maybeRationale,
      }
    }
    urls.push(...state.candidates.slice(0, state.config.readTopK).map((c) => c.url))
  }
  if (action === "reflect" && gaps.length === 0) {
    action = state.candidates.length > 0 ? "read" : "search"
    if (action === "search") queries.push(nextGap(state))
    else urls.push(...state.candidates.slice(0, state.config.readTopK).map((c) => c.url))
  }

  return { action, queries, urls, gaps, ...maybeRationale }
}

/** Deterministic fallback when the model can't be parsed. */
export function heuristicDecision(state: ResearchState, allowAnswer: boolean): ActionDecision {
  if (state.candidates.length > 0) {
    return {
      action: "read",
      queries: [],
      urls: state.candidates.slice(0, state.config.readTopK).map((c) => c.url),
      gaps: [],
    }
  }
  if (allowAnswer && state.knowledge.length > 0) {
    return { action: "answer", queries: [], urls: [], gaps: [] }
  }
  return { action: "search", queries: [nextGap(state)], urls: [], gaps: [] }
}

/** The next sub-question to chase (head of the FIFO gap queue, else the question). */
function nextGap(state: ResearchState): string {
  return state.gapQueue[0] ?? state.question
}

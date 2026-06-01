/**
 * Research state + IterResearch-style workspace reconstruction.
 *
 * Rather than letting context grow O(steps) (which degrades long-horizon
 * reasoning — the "context suffocation" IterResearch identifies), each step
 * works against a bounded, reconstructed workspace: the question, an evolving
 * report that serves as the agent's memory, and just the immediate context
 * (unread candidates + open gaps + recent knowledge). Old raw trajectory is
 * not replayed into the model.
 */
import type {
  DeepSearchConfig,
  KnowledgeItem,
  ResearchAction,
  ResearchStep,
  SearchHit,
} from "../types"

export interface ResearchState {
  question: string
  config: DeepSearchConfig
  /** FIFO sub-questions to chase; the original question is seeded first. */
  gapQueue: string[]
  /** Searched-but-unread hits. */
  candidates: SearchHit[]
  /** Canonicalised URLs already read. */
  visitedUrls: Set<string>
  /** Normalised queries already issued (dedup). */
  searchedQueries: Set<string>
  /** Accepted evidence. */
  knowledge: KnowledgeItem[]
  badAttempts: number
  /** IterResearch memory: a compact running digest of what we've learned. */
  evolvingReport: string
  steps: ResearchStep[]
  tokensUsed: number
  step: number
  /** Budget-forcing toggle — set false right after a failed answer attempt. */
  allowAnswer: boolean
}

const MAX_REPORT_CHARS = 4_000
const MAX_NOTE_CHARS = 280

export function initState(question: string, config: DeepSearchConfig): ResearchState {
  return {
    question,
    config,
    gapQueue: [question],
    candidates: [],
    visitedUrls: new Set(),
    searchedQueries: new Set(),
    knowledge: [],
    badAttempts: 0,
    evolvingReport: "",
    steps: [],
    tokensUsed: 0,
    step: 0,
    allowAnswer: true,
  }
}

export function recordStep(state: ResearchState, action: ResearchAction, detail: string): void {
  state.steps.push({ step: state.step, action, detail })
}

/**
 * Fold a new fact into the evolving report (memory). Kept bounded: notes are
 * truncated and the report is trimmed to the most recent slice once it grows
 * past the cap, so the workspace stays a constant size regardless of depth.
 */
export function appendReportNote(state: ResearchState, note: string): void {
  const trimmed = note.replace(/\s+/g, " ").trim().slice(0, MAX_NOTE_CHARS)
  if (!trimmed) return
  const next = state.evolvingReport ? `${state.evolvingReport}\n- ${trimmed}` : `- ${trimmed}`
  state.evolvingReport =
    next.length > MAX_REPORT_CHARS ? next.slice(next.length - MAX_REPORT_CHARS) : next
}

/** Render the bounded workspace passed to the model each step. */
export function renderWorkspace(state: ResearchState): string {
  const parts: string[] = []
  parts.push(`QUESTION: ${state.question}`)

  if (state.evolvingReport) {
    parts.push(`\nWHAT WE KNOW SO FAR (memory):\n${state.evolvingReport}`)
  }

  if (state.gapQueue.length > 0) {
    parts.push(`\nOPEN QUESTIONS:\n${state.gapQueue.map((g) => `- ${g}`).join("\n")}`)
  }

  if (state.candidates.length > 0) {
    const top = state.candidates
      .slice(0, 8)
      .map((c, i) => `[${i + 1}] ${c.title} — ${c.url}`)
      .join("\n")
    parts.push(`\nUNREAD SOURCES (${state.candidates.length}):\n${top}`)
  }

  parts.push(
    `\nPROGRESS: step ${state.step}/${state.config.maxSteps}, ` +
      `${state.knowledge.length} sources read, ` +
      `${state.tokensUsed}/${state.config.tokenBudget} tokens, ` +
      `${state.badAttempts} failed answer attempt(s).`
  )

  return parts.join("\n")
}

/**
 * Compact, citation-numbered evidence block for the answer/eval prompts.
 * `[n]` indices are stable and map to `state.knowledge[n-1]`.
 */
export function renderEvidence(state: ResearchState, maxChars = 1_200): string {
  if (state.knowledge.length === 0) return "(no sources gathered yet)"
  return state.knowledge
    .map((k, i) => `[${i + 1}] ${k.title} (${k.url})\n${k.content.slice(0, maxChars)}`)
    .join("\n\n")
}

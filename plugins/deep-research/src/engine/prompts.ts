/**
 * Prompt builders for the DeepSearch loop. Kept in one place so the wording
 * (the real "product") is easy to tune. Every builder returns `AiMessage[]`.
 *
 * Each system instruction is also declared to the host (`ctx.prompts`) as a
 * Prompt Center slot, so the user can tune the wording without a new plugin
 * build. Only the instruction is editable: today's date, the reply locale and
 * every user message, which carry the JSON shapes the engine parses, stay
 * here. Without an override, or without a host that resolves prompts, each
 * builder sends exactly the declared default.
 */
import type { PluginPromptDeclaration } from "@cognia/plugin-sdk"

import type { AiMessage } from "../lib/ai"

export const DEEP_RESEARCH_PROMPTS = [
  {
    id: "decide-action",
    title: "Deep Research: next step",
    description:
      "Chooses whether to search, read, reflect or answer at each step of a research run.",
    defaultBody:
      "You are the controller of an iterative web-research agent. Each turn you " +
      "pick exactly ONE next action that best advances toward a well-grounded " +
      "answer. Prefer reading unread sources before searching again; reflect to " +
      "break the question into sub-questions when stuck. Only answer when the " +
      "evidence actually supports a confident, citable response.",
    outputContract:
      "The user message asks for one JSON action object; keep the wording about choosing ONE action.",
    group: "knowledge",
  },
  {
    id: "outline",
    title: "Deep Research: report outline",
    description: "Designs a report's sections from a scan of the topic's landscape.",
    defaultBody:
      "You are a research lead planning a report. Using the landscape scan, design " +
      "a focused outline: a title plus 3-6 sections, each a distinct facet with a " +
      "specific, searchable research question. Avoid overlap between sections.",
    outputContract: 'The user message asks for {"title","sections":[{"heading","question"}]} JSON.',
    group: "knowledge",
  },
  {
    id: "coherence",
    title: "Deep Research: final report",
    description: "Merges the section findings into one coherent, cited report.",
    defaultBody:
      "You are a senior analyst assembling a final research report. Merge the " +
      "section findings into one coherent markdown report: a short executive " +
      "summary, then the sections in a logical order with smooth transitions and " +
      "unified terminology. Every inline [n] citation marker already indexes the " +
      "consolidated Sources list — copy each marker EXACTLY as written, never " +
      'renumber them, and drop any per-section "Sources" lists you find. Never ' +
      "invent facts or sources. Remove redundancy.",
    requiredFragments: ["[n]"],
    outputContract:
      "Markdown; inline [n] markers must survive unchanged because they index the Sources list.",
    group: "knowledge",
  },
  {
    id: "draft-answer",
    title: "Deep Research: cited answer",
    description: "Writes the answer from the gathered sources with inline [n] citations.",
    defaultBody:
      "You are a meticulous research analyst. Write a direct, accurate answer " +
      "grounded ONLY in the provided sources. Attach inline citations like [1], " +
      "[2] referencing the source numbers. Never invent facts or citations.",
    outputContract: "Markdown with inline [n] citations that index the numbered sources.",
    group: "knowledge",
  },
  {
    id: "draft-answer-budget",
    title: "Deep Research: answer when out of budget",
    description: "Added to the answer instruction when the research budget is spent.",
    defaultBody:
      "You are out of research budget: commit to the best answer the current " +
      "evidence supports, and clearly flag any remaining uncertainty.",
    group: "knowledge",
  },
  {
    id: "evaluate",
    title: "Deep Research: answer check",
    description: "Judges a candidate answer against the sources before it is accepted.",
    defaultBody:
      "You are a strict answer evaluator. Decide the evaluation criteria " +
      "appropriate to the question (e.g. factual accuracy, completeness, " +
      "freshness, directness), then judge the candidate answer against the " +
      "sources. An answer fails if any claim is unsupported by the sources, if " +
      "the question is not actually answered, or if the sources directly " +
      "contradict each other and the answer papers over it.",
    outputContract: 'The user message asks for {"pass": boolean, "reasons": [...]} JSON.',
    group: "knowledge",
  },
] as const satisfies readonly PluginPromptDeclaration[]

export type DeepResearchPromptId = (typeof DEEP_RESEARCH_PROMPTS)[number]["id"]

const DEFAULTS = Object.fromEntries(
  DEEP_RESEARCH_PROMPTS.map((prompt) => [prompt.id, prompt.defaultBody])
) as Record<DeepResearchPromptId, string>

/** The plugin's own text for a prompt. */
export function defaultSystemPrompt(id: DeepResearchPromptId): string {
  return DEFAULTS[id]
}

/** Resolves a prompt's text for the current run (the host's `ctx.prompts.resolve`). */
export type SystemPromptResolver = (id: DeepResearchPromptId) => Promise<string>

/**
 * The text to send for `id`: the resolver's answer, else the default. A host
 * without prompt resolution, or one that fails to answer, never stops a run.
 */
export async function systemPromptFor(
  id: DeepResearchPromptId,
  resolver?: SystemPromptResolver
): Promise<string> {
  if (!resolver) return DEFAULTS[id]
  try {
    return await resolver(id)
  } catch {
    return DEFAULTS[id]
  }
}

function localeLine(locale?: string): string {
  return locale ? `\nRespond in the user's locale: ${locale}.` : ""
}

/**
 * The model has no clock. Without an explicit date, "latest", "recent" and
 * "in 2025" are judged against the training cutoff, and stale pages read as
 * current. Anchoring on today's ISO date makes freshness a decidable signal.
 */
function todayLine(): string {
  return `\nToday is ${new Date().toISOString().slice(0, 10)}.`
}

/**
 * Ask the model to choose the next move. The model sees the bounded workspace
 * and must return a single JSON object. `allowAnswer=false` hard-blocks the
 * `answer` action (budget-forcing after a failed attempt).
 */
export function decideActionMessages(
  workspace: string,
  allowAnswer: boolean,
  locale?: string,
  instruction: string = DEFAULTS["decide-action"]
): AiMessage[] {
  const actions = allowAnswer
    ? `"search" | "read" | "reflect" | "answer"`
    : `"search" | "read" | "reflect"  (you may NOT answer yet — gather more first)`
  const system = instruction + todayLine() + localeLine(locale)
  const user =
    `${workspace}\n\n` +
    `Choose the next action. Return ONLY a JSON object:\n` +
    `{\n` +
    `  "action": ${actions},\n` +
    `  "queries": ["search query", "...diversified / multilingual variants (1-3)"] ,  // for "search"\n` +
    `  "urls": ["url to read from the UNREAD SOURCES list"],                          // for "read"\n` +
    `  "gaps": ["specific sub-question to investigate"],                              // for "reflect"\n` +
    `  "rationale": "one short sentence"\n` +
    `}\n` +
    `Include only the field relevant to the chosen action (plus rationale).`
  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ]
}

/**
 * Evidence-grounded outline (DeepResearch). The architect designs the report
 * structure AFTER scouting the landscape, so depth/breadth follow real findings
 * rather than a blind guess.
 */
export function outlineMessages(
  topic: string,
  landscape: string,
  locale?: string,
  instruction: string = DEFAULTS.outline
): AiMessage[] {
  const system = instruction + todayLine() + localeLine(locale)
  const user =
    `TOPIC: ${topic}\n\n` +
    `LANDSCAPE SCAN:\n${landscape || "(no preliminary results)"}\n\n` +
    `Return ONLY JSON:\n` +
    `{"title":"report title","sections":[{"heading":"Section heading","question":"the specific question this section answers"}]}`
  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ]
}

/**
 * Coherence pass (DeepResearch): merge per-section findings into one report,
 * unifying terminology + transitions while preserving every citation.
 */
export function coherenceMessages(
  topic: string,
  title: string,
  sectionBlocks: string,
  locale?: string,
  instruction: string = DEFAULTS.coherence
): AiMessage[] {
  const system = instruction + localeLine(locale)
  const user =
    `TOPIC: ${topic}\nWORKING TITLE: ${title}\n\n` +
    `SECTION FINDINGS:\n${sectionBlocks}\n\n` +
    `Write the final markdown report. Do not append a sources list — one is ` +
    `added automatically.`
  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ]
}

/**
 * Synthesise the final answer, grounded in the numbered evidence. In beast
 * mode the model must commit to the best possible answer from what's known.
 */
export function draftAnswerMessages(
  question: string,
  evidence: string,
  beast: boolean,
  locale?: string,
  instruction: string = DEFAULTS["draft-answer"],
  budgetInstruction: string = DEFAULTS["draft-answer-budget"]
): AiMessage[] {
  const system =
    instruction + (beast ? ` ${budgetInstruction}` : "") + todayLine() + localeLine(locale)
  const user =
    `QUESTION: ${question}\n\n` +
    `SOURCES:\n${evidence}\n\n` +
    `Write the answer with inline [n] citations. Do not append a sources list — ` +
    `one is rendered from the citation data automatically.`
  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ]
}

/**
 * Independent evaluation (separate from generation — self-eval is unreliable).
 * The model first derives criteria for the question type, then checks the
 * answer against the evidence and returns a verdict.
 */
export function evaluateMessages(
  question: string,
  answer: string,
  evidence: string,
  locale?: string,
  instruction: string = DEFAULTS.evaluate
): AiMessage[] {
  const system = instruction + todayLine() + localeLine(locale)
  const user =
    `QUESTION: ${question}\n\n` +
    `CANDIDATE ANSWER:\n${answer}\n\n` +
    `SOURCES:\n${evidence}\n\n` +
    `Return ONLY JSON: {"pass": boolean, "reasons": ["..."]}.`
  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ]
}

/**
 * Prompt builders for the DeepSearch loop. Kept in one place so the wording
 * (the real "product") is easy to tune. Every builder returns `AiMessage[]`.
 */
import type { AiMessage } from "../lib/ai"

function localeLine(locale?: string): string {
  return locale ? `\nRespond in the user's locale: ${locale}.` : ""
}

/**
 * Ask the model to choose the next move. The model sees the bounded workspace
 * and must return a single JSON object. `allowAnswer=false` hard-blocks the
 * `answer` action (budget-forcing after a failed attempt).
 */
export function decideActionMessages(
  workspace: string,
  allowAnswer: boolean,
  locale?: string
): AiMessage[] {
  const actions = allowAnswer
    ? `"search" | "read" | "reflect" | "answer"`
    : `"search" | "read" | "reflect"  (you may NOT answer yet — gather more first)`
  const system =
    "You are the controller of an iterative web-research agent. Each turn you " +
    "pick exactly ONE next action that best advances toward a well-grounded " +
    "answer. Prefer reading unread sources before searching again; reflect to " +
    "break the question into sub-questions when stuck. Only answer when the " +
    "evidence actually supports a confident, citable response." +
    localeLine(locale)
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
export function outlineMessages(topic: string, landscape: string, locale?: string): AiMessage[] {
  const system =
    "You are a research lead planning a report. Using the landscape scan, design " +
    "a focused outline: a title plus 3-6 sections, each a distinct facet with a " +
    "specific, searchable research question. Avoid overlap between sections." +
    localeLine(locale)
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
  locale?: string
): AiMessage[] {
  const system =
    "You are a senior analyst assembling a final research report. Merge the " +
    "section findings into one coherent markdown report: a short executive " +
    "summary, then the sections in a logical order with smooth transitions and " +
    "unified terminology. PRESERVE every inline [n] citation marker and source " +
    "URL exactly; never invent facts or sources. Remove redundancy." +
    localeLine(locale)
  const user =
    `TOPIC: ${topic}\nWORKING TITLE: ${title}\n\n` +
    `SECTION FINDINGS:\n${sectionBlocks}\n\n` +
    `Write the final markdown report. End with a single consolidated "Sources" ` +
    `list (deduplicated).`
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
  locale?: string
): AiMessage[] {
  const system =
    "You are a meticulous research analyst. Write a direct, accurate answer " +
    "grounded ONLY in the provided sources. Attach inline citations like [1], " +
    "[2] referencing the source numbers. Never invent facts or citations." +
    (beast
      ? " You are out of research budget: commit to the best answer the current " +
        "evidence supports, and clearly flag any remaining uncertainty."
      : "") +
    localeLine(locale)
  const user =
    `QUESTION: ${question}\n\n` +
    `SOURCES:\n${evidence}\n\n` +
    `Write the answer with inline [n] citations. End with a short "Sources:" ` +
    `list mapping each [n] to its URL.`
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
  _locale?: string
): AiMessage[] {
  const system =
    "You are a strict answer evaluator. Decide the evaluation criteria " +
    "appropriate to the question (e.g. factual accuracy, completeness, " +
    "freshness, directness), then judge the candidate answer against the " +
    "sources. An answer fails if any claim is unsupported by the sources or " +
    "the question is not actually answered."
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

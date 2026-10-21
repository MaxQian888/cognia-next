/**
 * Greppable signals of dated or brittle instruction text (ADR-0238 §7.2).
 *
 * These are the "Signals" rows of the prompt-audit method, run over rule
 * units instead of eyeballed. A signal is a lead, not a verdict: matching
 * `IMPORTANT` says nothing about whether the line guards a demonstrated
 * failure. Every hit goes to the model's judgment as a hint, and only stands
 * on its own (as a low-confidence `flag`, never an edit) when no judgment is
 * available. The keep list lives in the judgment prompt, not here.
 */

import type { FindingGroup } from "../model"
import type { RuleUnit } from "./segment"

export type SignalId =
  | "pressure-language"
  | "hedged-requirement"
  | "trait-claim"
  | "thinking-scaffold"
  | "thinking-depth-prose"
  | "numeric-output-cap"
  | "fixed-cadence"
  | "step-choreography"
  | "prohibition-cluster"
  | "grader-vocabulary"
  | "repetition-marker"
  | "retired-model-name"
  | "update-suppressor"
  | "anti-formatting"
  | "tool-discouragement"
  | "identity-stub"
  | "history-narrative"
  | "date-conditional"
  | "trigger-enumeration"
  | "oversized-skill"

export interface SignalHit {
  signal: SignalId
  group: FindingGroup
  /** The unit's first line, 1-based. */
  startLine: number
  endLine: number
  /** The exact matched text, or the unit for unit-level signals. */
  evidence: string
}

interface LineSignal {
  id: SignalId
  group: FindingGroup
  pattern: RegExp
}

const LINE_SIGNALS: readonly LineSignal[] = [
  // 1a — emphasis in caps; a single word in caps is how an anxious prompt reads.
  {
    id: "pressure-language",
    group: "dated-text",
    pattern: /\b(?:MUST|NEVER|ALWAYS|CRITICAL|IMPORTANT)\b|!!/,
  },
  { id: "hedged-requirement", group: "dated-text", pattern: /\b(?:try to|if possible|ideally)\b/i },
  {
    id: "trait-claim",
    group: "dated-text",
    pattern: /\byou (?:tend to|often|sometimes)\b|\bdon'?t be too \w+/i,
  },
  // 1b — scaffolds the model or the API now provides.
  {
    id: "thinking-scaffold",
    group: "dated-text",
    pattern: /think step[- ]by[- ]step|take a deep breath|<(?:scratchpad|thinking|brainstorm)>/i,
  },
  {
    id: "thinking-depth-prose",
    group: "dated-text",
    pattern: /\bthink (?:harder|less)\b|don'?t overthink|\bdo not think\b/i,
  },
  {
    id: "numeric-output-cap",
    group: "dated-text",
    pattern: /\b(?:at most|no more than|under|fewer than) \d+ (?:words|sentences|bullets|lines)\b/i,
  },
  {
    id: "fixed-cadence",
    group: "dated-text",
    pattern:
      /\bevery \d+(?:st|nd|rd|th)? (?:tool calls?|messages?|turns?|steps?)\b|\bafter every (?:\w+ )?tool call\b/i,
  },
  // 1c — over-specification.
  { id: "step-choreography", group: "dated-text", pattern: /^\s*(?:STEP \d+\b|Step \d+:)/ },
  {
    id: "grader-vocabulary",
    group: "dated-text",
    pattern: /\b(?:graded|grader|rubric|hidden tests?)\b/i,
  },
  {
    id: "repetition-marker",
    group: "dated-text",
    pattern: /^(?:Remember,|Again,|As (?:stated|mentioned) above)/i,
  },
  // 1d — fossils.
  {
    id: "retired-model-name",
    group: "dated-text",
    pattern:
      /\b(?:claude-2(?:\.\d)?|claude-instant|claude-3(?:[.-]\d)?(?:-(?:opus|sonnet|haiku))?|claude 3(?:\.\d)?|gpt-3\.5(?:-turbo)?|text-davinci-\d+|gpt-4-(?:0314|0613|32k)|gemini-1\.[05])\b/i,
  },
  {
    id: "update-suppressor",
    group: "dated-text",
    pattern:
      /\bhold (?:all )?(?:findings|results)\b|don'?t narrate|\bno interim (?:updates|messages)\b/i,
  },
  {
    id: "anti-formatting",
    group: "dated-text",
    pattern:
      /\bnever use (?:bullets|bullet points|headers|headings|bold)\b|\bno (?:bullet points|bullets|headers|headings)\b/i,
  },
  {
    id: "tool-discouragement",
    group: "dated-text",
    pattern:
      /\bonly use tools when (?:strictly )?necessary\b|\bminimi[sz]e (?:the number of )?tool calls\b/i,
  },
  // Group 2 — history and dates rot.
  {
    id: "history-narrative",
    group: "brittle-config",
    pattern: /\b(?:PR|pull request|issue|incident) #?\d{2,}\b|\blast time we\b|\bwe used to\b/i,
  },
  {
    id: "date-conditional",
    group: "brittle-config",
    pattern:
      /\b(?:before|after|until|since) (?:20\d{2}-\d{2}(?:-\d{2})?|(?:January|February|March|April|May|June|July|August|September|October|November|December) \d{1,2},? 20\d{2})\b/i,
  },
]

const PROHIBITION_START = /^(?:do not|don'?t|never|avoid|must not)\b/i
const IDENTITY_STUB = /^you are (?:a|an) (?:helpful|expert|world[- ]class|senior)\b/i

/** Lines of a SKILL.md body past which it cannot be read in one sitting. */
export const OVERSIZED_SKILL_LINES = 500
/** Quoted example phrases in a description past which it enumerates triggers. */
export const TRIGGER_ENUMERATION_QUOTES = 6

/**
 * Signals over one surface: `units` from `segmentRules(text)` and the same
 * text's `lines`, so a hit names the exact line it matched on. `isSkill` adds
 * the Skill-only checks.
 */
export function scanSignals(
  units: readonly RuleUnit[],
  lines: readonly string[],
  options: { isSkill?: boolean } = {}
): SignalHit[] {
  const hits: SignalHit[] = []
  for (const unit of units) {
    if (unit.kind === "code" || unit.kind === "heading") continue
    if (unit.kind === "frontmatter") {
      const quotes = unit.text.match(/["“][^"”]{2,60}["”]/g) ?? []
      if (options.isSkill && quotes.length >= TRIGGER_ENUMERATION_QUOTES) {
        hits.push({
          signal: "trigger-enumeration",
          group: "descriptions",
          startLine: unit.startLine,
          endLine: unit.endLine,
          evidence: quotes.slice(0, 3).join(", "),
        })
      }
      continue
    }
    for (const signal of LINE_SIGNALS) {
      for (let line = unit.startLine; line <= unit.endLine; line++) {
        const match = signal.pattern.exec(lines[line - 1] ?? "")
        if (!match) continue
        hits.push({
          signal: signal.id,
          group: signal.group,
          startLine: line,
          endLine: line,
          evidence: match[0],
        })
        break
      }
    }
  }

  // 1c/1e — a run of three or more prohibitions in a row.
  const behavior = units.filter((unit) => unit.kind !== "heading" && unit.kind !== "code")
  let run: RuleUnit[] = []
  const flushRun = () => {
    if (run.length >= 3) {
      hits.push({
        signal: "prohibition-cluster",
        group: "dated-text",
        startLine: run[0]!.startLine,
        endLine: run[run.length - 1]!.endLine,
        evidence: run.map((unit) => unit.text.split(/[.;]/)[0]).join(" / "),
      })
    }
    run = []
  }
  for (const unit of behavior) {
    if (PROHIBITION_START.test(unit.text)) run.push(unit)
    else flushRun()
  }
  flushRun()

  // 1d — an identity line standing in for context.
  const prose = units.filter((unit) => unit.kind === "paragraph" || unit.kind === "bullet")
  const first = prose[0]
  if (first && IDENTITY_STUB.test(first.text) && prose.length <= 1) {
    hits.push({
      signal: "identity-stub",
      group: "dated-text",
      startLine: first.startLine,
      endLine: first.endLine,
      evidence: first.text,
    })
  }

  if (options.isSkill && lines.length > OVERSIZED_SKILL_LINES) {
    hits.push({
      signal: "oversized-skill",
      group: "brittle-config",
      startLine: 1,
      endLine: lines.length,
      evidence: `${lines.length} lines`,
    })
  }
  return hits
}

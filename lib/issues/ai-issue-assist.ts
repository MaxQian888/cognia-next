/**
 * Issue-create AI assistance — the model calls behind the ✨ menu on the
 * GitHub-style create surface.
 *
 * Five intents, all text-in/structured-out over an injected `LlmClient`:
 *   • draft   — title → a full markdown issue body (summary / steps /
 *               acceptance checklist), so a one-line title becomes a
 *               reviewable issue in one click;
 *   • improve — rewrite an existing draft body into tighter, well-structured
 *               markdown, preserving code, paths and mentions verbatim;
 *   • suggest — title + body → `{ priority, labelNames, estimate }` picked
 *               from the caller's actual catalogues, applied as metadata;
 *   • title   — body → a concise one-line title, for write-body-first flows;
 *   • link    — title + body + the existing issue list → `{ parentId,
 *               blockedByIds, duplicateIds }`, identifiers canonicalised back
 *               to ids so the result is applyable as-is.
 *
 * Same contract as `lib/chat/completion/enhance.ts`: pure + dependency
 * injected so prompt/cleanup logic is testable without a model; the draft
 * inputs pass `hasNoLeakingPii` before anything leaves the device; and the
 * caller owns client resolution (`buildUtilityLlmClient` → headless turn)
 * plus how a `skipped` result is surfaced.
 */

import { hasNoLeakingPii } from "@cognia/redact"
import { extractJson, type LlmClient } from "@/lib/twin/distill/llm"
import { ISSUE_PRIORITIES, type IssuePriority } from "@/types/issues"

export interface IssueAssistDeps {
  client: LlmClient
  /** PII gate. Defaults to the shared `hasNoLeakingPii`. */
  isPiiSafe?: (text: string) => boolean
  signal?: AbortSignal
  /**
   * Streaming sink: when set and the client supports `stream`, each
   * accumulated draft is reported as it grows (the caller mirrors it into a
   * textarea for a live-typing effect). Falls back to `complete` silently
   * when the client has no stream — the final result is identical either way.
   */
  onAccumulated?: (text: string) => void
}

export type IssueAssistResult =
  { kind: "text"; text: string } | { kind: "skipped"; reason: "pii" | "empty" | "no-output" }

export interface IssueMetadataSuggestion {
  priority?: IssuePriority
  /** Label names echoed back from the caller-provided catalogue only. */
  labelNames: string[]
  /** Story-point estimate restricted to the board's preset buckets. */
  estimate?: number
}

export type IssueSuggestResult =
  | { kind: "suggestion"; suggestion: IssueMetadataSuggestion }
  | { kind: "skipped"; reason: "pii" | "empty" | "no-output" }

export interface IssueRelationsSuggestion {
  /** Existing issue the draft is a sub-task of, if the model found one. */
  parentId?: string
  /** Existing issues that must land before this draft. */
  blockedByIds: string[]
  /** Existing issues that already describe this work — the dup-warning strip. */
  duplicateIds: string[]
}

export type IssueRelationsResult =
  | { kind: "suggestion"; suggestion: IssueRelationsSuggestion }
  | { kind: "skipped"; reason: "pii" | "empty" | "no-output" }

/** Hard caps on model output — runaway-generation guard. */
const MAX_BODY_LEN = 8_000
const MAX_SUGGESTED_LABELS = 6
const MAX_TITLE_LEN = 120
const MAX_RELATION_CANDIDATES = 50
const ESTIMATE_BUCKETS = [1, 2, 3, 5, 8] as const

const DRAFT_SYSTEM = [
  "You are an assistant that drafts software-engineering issue reports.",
  "Given an issue title (and optional project name), write a complete",
  "GitHub-style issue body in markdown.",
  "Use short sections with ## headings — e.g. ## Summary, ## Steps to",
  "reproduce, ## Expected, ## Actual — whichever fit the title. End with an",
  "## Acceptance criteria task list (- [ ] items) when the work is checkable.",
  "Be concrete but do not invent facts like file paths, versions or people:",
  "write [fill in] placeholders where the reporter must supply specifics.",
  "Output ONLY the markdown body: no preamble, no quotes, no code fence",
  "around the whole reply.",
].join(" ")

const IMPROVE_SYSTEM = [
  "You are an editor for software-engineering issue reports written in",
  "markdown. Rewrite the draft into a clearer, well-structured issue body:",
  "## section headings where they help, tightened prose, acceptance criteria",
  "as a - [ ] task list when checkable.",
  "Preserve code blocks, file paths, identifiers, @-mentions and every fact",
  "verbatim — reorganize and clarify, never invent new specifics.",
  "Output ONLY the rewritten markdown body: no preamble, no quotes, no",
  "wrapping code fence.",
].join(" ")

const SUGGEST_SYSTEM = [
  "You classify software-engineering issues. Read the title and body, then",
  "pick a priority, any matching labels, and a story-point estimate STRICTLY",
  "from the provided catalogues. Return ONLY a JSON object, no prose:",
  '{"priority": "<one of the listed values or null>", "labels": ["<exact label name>", ...], "estimate": <one of 1,2,3,5,8 or null>}',
].join(" ")

const TITLE_SYSTEM = [
  "You write concise software-engineering issue titles.",
  "Given an issue body, return ONE title: a single line under 80 characters,",
  "descriptive and imperative where it fits, no quotes, no trailing period,",
  "no type prefix like 'Bug:'. Output ONLY the title text.",
].join(" ")

const RELATIONS_SYSTEM = [
  "You link software-engineering issues. Given a draft issue (title + body)",
  "and a list of existing issues (identifier + title), decide:",
  "- parent: the ONE existing issue this draft is clearly a sub-task of",
  "- blockedBy: existing issues that must land before this draft can start",
  "- duplicates: existing issues that already describe the same work",
  "Prefer empty results over guessing — only link what is clearly implied.",
  "Return ONLY a JSON object, no prose:",
  '{"parent": "<identifier or null>", "blockedBy": ["<identifier>", ...], "duplicates": ["<identifier>", ...]}',
].join(" ")

/** Strip ``` fences / wrapping quotes a model adds despite instructions. */
function cleanBody(raw: string): string {
  let out = raw.trim()
  if (out.startsWith("```")) {
    out = out.replace(/^```[a-zA-Z0-9-]*\n?/, "").replace(/```\s*$/, "")
  }
  out = out.trim()
  if (out.length >= 2) {
    const first = out[0]
    const last = out[out.length - 1]
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      out = out.slice(1, -1).trim()
    }
  }
  return out
}

type SkippedResult = Extract<IssueAssistResult, { kind: "skipped" }>

function gate(text: string, deps: IssueAssistDeps): SkippedResult | null {
  if (text.trim().length === 0) return { kind: "skipped", reason: "empty" }
  const isPiiSafe = deps.isPiiSafe ?? hasNoLeakingPii
  if (!isPiiSafe(text)) return { kind: "skipped", reason: "pii" }
  return null
}

/**
 * Draft a full markdown body from the title. Returns `skipped/empty` when
 * there is no title to draft from, `skipped/pii` when the title must not
 * leave the device, `skipped/no-output` on an unusable model reply.
 */
export async function draftIssueDescription(
  title: string,
  deps: IssueAssistDeps & { projectName?: string }
): Promise<IssueAssistResult> {
  const blocked = gate(title, deps)
  if (blocked) return blocked

  const prompt = [
    deps.projectName ? `Project: ${deps.projectName}` : null,
    `Issue title: ${title.trim()}`,
    "",
    "Write the issue body now.",
  ]
    .filter(Boolean)
    .join("\n")

  const callOptions = {
    system: DRAFT_SYSTEM,
    temperature: 0.4,
    maxTokens: 2_048,
    abortSignal: deps.signal,
  }
  let raw: string
  if (deps.onAccumulated && deps.client.stream) {
    let accumulated = ""
    for await (const delta of deps.client.stream(prompt, callOptions)) {
      accumulated += delta
      deps.onAccumulated(accumulated)
    }
    raw = accumulated
  } else {
    raw = await deps.client.complete(prompt, callOptions)
  }
  const text = cleanBody(raw)
  if (text.length === 0 || text.length > MAX_BODY_LEN) {
    return { kind: "skipped", reason: "no-output" }
  }
  return { kind: "text", text }
}

/**
 * Rewrite an existing draft body into a better-structured issue. Skips on
 * empty input — an empty editor wants `draftIssueDescription` instead.
 */
export async function improveIssueDescription(
  draft: string,
  deps: IssueAssistDeps
): Promise<IssueAssistResult> {
  const blocked = gate(draft, deps)
  if (blocked) return blocked

  const raw = await deps.client.complete(`Issue body to rewrite:\n\n${draft}`, {
    system: IMPROVE_SYSTEM,
    temperature: 0.3,
    maxTokens: 2_048,
    abortSignal: deps.signal,
  })
  const text = cleanBody(raw)
  if (text.length === 0 || text.length > MAX_BODY_LEN || text === draft.trim()) {
    return { kind: "skipped", reason: "no-output" }
  }
  return { kind: "text", text }
}

/**
 * Suggest priority + labels for the issue, restricted to the caller's
 * catalogues. The model is asked for label *names*; anything it returns
 * outside `labelNames` is dropped (case-insensitive match back to the
 * canonical name), so the result is always applyable as-is.
 */
export async function suggestIssueMetadata(
  args: { title: string; description: string; labelNames: readonly string[] },
  deps: IssueAssistDeps
): Promise<IssueSuggestResult> {
  const combined = `${args.title}\n${args.description}`
  const blocked = gate(combined, deps)
  if (blocked) return { kind: "skipped", reason: blocked.reason }

  const prompt = [
    `Allowed priorities: ${ISSUE_PRIORITIES.join(", ")}`,
    `Allowed labels: ${args.labelNames.length > 0 ? args.labelNames.join(", ") : "(none)"}`,
    "",
    `Issue title: ${args.title.trim()}`,
    args.description.trim() ? `Issue body:\n${args.description.trim()}` : null,
    "",
    "Return the JSON classification now.",
  ]
    .filter(Boolean)
    .join("\n")

  let parsed: unknown
  try {
    const raw = await deps.client.complete(prompt, {
      system: SUGGEST_SYSTEM,
      temperature: 0,
      maxTokens: 512,
      abortSignal: deps.signal,
    })
    parsed = extractJson<unknown>(raw)
  } catch {
    return { kind: "skipped", reason: "no-output" }
  }
  if (!parsed || typeof parsed !== "object") return { kind: "skipped", reason: "no-output" }

  const record = parsed as Record<string, unknown>
  const priority = ISSUE_PRIORITIES.find((p) => p === record.priority)
  const estimate = ESTIMATE_BUCKETS.find((points) => points === record.estimate)
  const canonical = new Map(args.labelNames.map((name) => [name.toLowerCase(), name]))
  const labelNames = (Array.isArray(record.labels) ? record.labels : [])
    .filter((name): name is string => typeof name === "string")
    .map((name) => canonical.get(name.trim().toLowerCase()))
    .filter((name): name is string => Boolean(name))
    .filter((name, index, all) => all.indexOf(name) === index)
    .slice(0, MAX_SUGGESTED_LABELS)

  if (!priority && labelNames.length === 0 && estimate === undefined) {
    return { kind: "skipped", reason: "no-output" }
  }
  return { kind: "suggestion", suggestion: { priority, labelNames, estimate } }
}

/**
 * Title from the body — the inverse of `draftIssueDescription`, for the
 * write-body-first flow. Single line, stripped of quotes/periods, capped.
 */
export async function suggestIssueTitle(
  description: string,
  deps: IssueAssistDeps
): Promise<IssueAssistResult> {
  const blocked = gate(description, deps)
  if (blocked) return blocked

  const raw = await deps.client.complete(`Issue body:\n\n${description.trim()}`, {
    system: TITLE_SYSTEM,
    temperature: 0.3,
    maxTokens: 96,
    abortSignal: deps.signal,
  })
  const text = cleanBody(raw)
    .split("\n")[0]
    .replace(/^#+\s*/, "")
    .replace(/[.。]+$/, "")
    .trim()
    .slice(0, MAX_TITLE_LEN)
  if (text.length === 0) return { kind: "skipped", reason: "no-output" }
  return { kind: "text", text }
}

/**
 * Pick the draft's parent, blockers and likely duplicates out of the existing
 * issue list. The model answers with *identifiers* (DEMO-3) — humans read
 * those, not internal ids — and each one is canonicalised back to an issue id;
 * anything not in the candidate list is dropped.
 */
export async function suggestIssueRelations(
  args: {
    title: string
    description: string
    candidates: readonly { id: string; identifier: string; title: string }[]
  },
  deps: IssueAssistDeps
): Promise<IssueRelationsResult> {
  if (args.candidates.length === 0) return { kind: "skipped", reason: "empty" }
  const combined = `${args.title}\n${args.description}`
  const blocked = gate(combined, deps)
  if (blocked) return { kind: "skipped", reason: blocked.reason }

  const prompt = [
    "Existing issues:",
    ...args.candidates
      .slice(0, MAX_RELATION_CANDIDATES)
      .map((issue) => `${issue.identifier} — ${issue.title}`),
    "",
    `Draft title: ${args.title.trim() || "(untitled)"}`,
    args.description.trim() ? `Draft body:\n${args.description.trim()}` : null,
    "",
    "Return the JSON now.",
  ]
    .filter(Boolean)
    .join("\n")

  let parsed: unknown
  try {
    const raw = await deps.client.complete(prompt, {
      system: RELATIONS_SYSTEM,
      temperature: 0,
      maxTokens: 512,
      abortSignal: deps.signal,
    })
    parsed = extractJson<unknown>(raw)
  } catch {
    return { kind: "skipped", reason: "no-output" }
  }
  if (!parsed || typeof parsed !== "object") return { kind: "skipped", reason: "no-output" }

  const record = parsed as Record<string, unknown>
  const idByIdentifier = new Map(
    args.candidates.map((issue) => [issue.identifier.trim().toLowerCase(), issue.id])
  )
  const toIds = (value: unknown): string[] =>
    (Array.isArray(value) ? value : [])
      .filter((identifier): identifier is string => typeof identifier === "string")
      .map((identifier) => idByIdentifier.get(identifier.trim().toLowerCase()))
      .filter((id): id is string => Boolean(id))
      .filter((id, index, all) => all.indexOf(id) === index)

  const parentId =
    typeof record.parent === "string"
      ? idByIdentifier.get(record.parent.trim().toLowerCase())
      : undefined
  const blockedByIds = toIds(record.blockedBy)
  const duplicateIds = toIds(record.duplicates)

  if (!parentId && blockedByIds.length === 0 && duplicateIds.length === 0) {
    return { kind: "skipped", reason: "no-output" }
  }
  return { kind: "suggestion", suggestion: { parentId, blockedByIds, duplicateIds } }
}

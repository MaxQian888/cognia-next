/**
 * Pure prompt assembly + one-shot generation for AI commit messages.
 *
 * Kept free of React, stores, and Tauri so it is trivially unit-testable: the
 * model + `generateText` are injected. The caller (`useAiCommitMessage`) owns
 * PII gating, model resolution, and writing the result into the commit draft.
 */

import type { LlmClient } from "@/lib/twin/distill/llm"
import type { GitFileChange } from "@/types/git"

export interface CommitMessageAIConfig {
  /** Constrain output to the Conventional Commits format. */
  conventionalCommits: boolean
  /** Optional extra steering appended to the system prompt. */
  customInstructions?: string
}

export interface BuildPromptInput {
  /** Staged diff text — already PII-gated / redacted by the caller. */
  diffText: string
  /** Staged file summary (path + status) so the model can pick a good scope. */
  files: Pick<GitFileChange, "path" | "status">[]
  config: CommitMessageAIConfig
  /**
   * What the user had already typed in the message box, PII-gated like the
   * diff. Treated as their intent to refine, not as text to keep verbatim.
   */
  draftHint?: string
}

/** Default character budget for the diff sent to the model (token-safe proxy). */
export const DEFAULT_DIFF_CHAR_BUDGET = 12_000

const CONVENTIONAL_CLAUSE = `Follow the Conventional Commits format: a subject line \`type(scope): summary\` where type is one of feat|fix|docs|style|refactor|perf|test|build|ci|chore, scope is optional, and the summary is in the imperative mood, no trailing period, at most 72 characters. Then a blank line, then an optional body explaining WHY the change was made (wrap around 72 columns). Omit the body for trivial changes.`

const FREEFORM_CLAUSE = `Write a concise subject line in the imperative mood (at most 72 characters, no trailing period), optionally followed by a blank line and a short body explaining WHY the change was made.`

export function buildCommitSystemPrompt(config: CommitMessageAIConfig): string {
  const lines = [
    "You write Git commit messages from a staged diff.",
    "Output ONLY the raw commit message — no markdown fences, no preamble, no quotes.",
    config.conventionalCommits ? CONVENTIONAL_CLAUSE : FREEFORM_CLAUSE,
    "Never invent changes that are not present in the diff.",
  ]
  const extra = config.customInstructions?.trim()
  if (extra) lines.push(`Additional instructions: ${extra}`)
  return lines.join("\n")
}

/**
 * Truncate the diff to a char budget, preserving the head (file headers + first
 * hunks carry the most signal) and flagging the omission so the model knows the
 * diff is partial.
 */
export function clampDiff(diffText: string, maxChars: number = DEFAULT_DIFF_CHAR_BUDGET): string {
  if (diffText.length <= maxChars) return diffText
  return `${diffText.slice(0, maxChars)}\n…[diff truncated for length]`
}

export function buildCommitUserPrompt(input: BuildPromptInput): string {
  const fileList =
    input.files.length > 0
      ? input.files.map((f) => `${statusLetter(f.status)} ${f.path}`).join("\n")
      : "(no staged file metadata)"
  const hint = input.draftHint?.trim()
  return [
    ...(hint
      ? ["The user's draft of the message (keep its intent, improve the wording):", hint, ""]
      : []),
    "Staged files:",
    fileList,
    "",
    "Staged diff:",
    "```diff",
    clampDiff(input.diffText),
    "```",
  ].join("\n")
}

/** The tag an agent wraps its answer in, so its narration can be told apart. */
export const COMMIT_MESSAGE_TAG = "commit-message"

const AGENT_CLAUSE = `You are running inside the repository the diff belongs to. You may read files for context, but do not modify anything, run commands that change state, or commit. When you are done, reply with the commit message wrapped in <${COMMIT_MESSAGE_TAG}> and </${COMMIT_MESSAGE_TAG}> tags, and nothing else after the closing tag.`

/**
 * The instructions for an agent lane. An agent narrates (tool use, a preamble),
 * so unlike the model lane it is asked to tag its answer.
 */
export function buildCommitAgentSystemPrompt(config: CommitMessageAIConfig): string {
  return `${buildCommitSystemPrompt(config)}\n${AGENT_CLAUSE}`
}

/**
 * The single prompt an agent receives. The instructions ride in the prompt as
 * well as in the system prompt, because not every adapter honours the latter.
 */
export function buildCommitAgentPrompt(input: BuildPromptInput): string {
  return `${buildCommitAgentSystemPrompt(input.config)}\n\n${buildCommitUserPrompt(input)}`
}

/**
 * The message out of an answer: the last tagged block when there is one (an
 * agent may quote the tag while thinking), else the answer with fences
 * stripped. Returns "" when nothing usable is left.
 */
export function extractCommitMessage(text: string): string {
  const pattern = new RegExp(`<${COMMIT_MESSAGE_TAG}>([\\s\\S]*?)</${COMMIT_MESSAGE_TAG}>`, "g")
  let tagged: string | undefined
  for (const match of text.matchAll(pattern)) tagged = match[1]
  return stripFences((tagged ?? text).trim())
}

function statusLetter(status: GitFileChange["status"]): string {
  switch (status) {
    case "added":
      return "A"
    case "deleted":
      return "D"
    case "renamed":
      return "R"
    case "untracked":
      return "?"
    case "typeChanged":
      return "T"
    case "conflicted":
      return "U"
    default:
      return "M"
  }
}

/** Strip markdown code fences a model may wrap the message in, then trim. */
export function stripFences(text: string): string {
  const fenced = text.match(/^```(?:[\w-]*)\n([\s\S]*?)\n```$/)
  return (fenced ? fenced[1] : text).trim()
}

/** Streaming and cancellation for {@link generateCommitMessage}. */
export interface GenerateCommitMessageOptions {
  /** The raw text so far, while it streams. Only used when the client streams. */
  onText?: (text: string) => void
  abortSignal?: AbortSignal
}

/**
 * One-shot generation: assemble prompts, call the resolved utility LLM client
 * (which honors the user's provider/model override), return clean text. The
 * client is injected so this stays testable with a mock `{ complete }`. A
 * client that streams, given an `onText`, reports the text as it arrives.
 */
export async function generateCommitMessage(
  input: BuildPromptInput,
  client: Pick<LlmClient, "complete" | "stream">,
  options: GenerateCommitMessageOptions = {}
): Promise<string> {
  const prompt = buildCommitUserPrompt(input)
  const callOptions = {
    system: buildCommitSystemPrompt(input.config),
    temperature: 0.3,
    maxTokens: 400,
    ...(options.abortSignal ? { abortSignal: options.abortSignal } : {}),
  }
  if (options.onText && client.stream) {
    let text = ""
    for await (const delta of client.stream(prompt, callOptions)) {
      text += delta
      options.onText(text)
    }
    return stripFences(text)
  }
  return stripFences(await client.complete(prompt, callOptions))
}

/**
 * The system-prompt frame every dispatched subagent runs inside.
 *
 * A subagent definition's `prompt` is its identity, and until now it was the
 * ENTIRE system prompt of a dispatched child in both shells: the CLI replaced
 * its base prompt with it (`buildChildConfig`), and the app's executor used it
 * as the character prompt. So a child never learned its working directory,
 * the date, or the one thing Claude Code tells every subagent up front: that
 * the dispatcher reads only the final message. Each built-in prompt restated
 * part of that contract in its own words, and user-authored agents got none
 * of it.
 *
 * This module composes the shared frame once, read by the CLI runner and the
 * app dispatch path alike, so the two cannot drift. It is idempotent: a prompt
 * that already carries the contract marker is returned unchanged, which keeps
 * a nested dispatch (a child framing a grandchild) from stacking frames.
 *
 * Pure and shell-agnostic. Every environment fact is passed in and omitted
 * when unknown, so the renderer (no `process.platform`) and the CLI produce
 * the same shape.
 */

/** Marker element. Its presence means the frame has already been applied. */
export const SUBAGENT_CONTRACT_TAG = "subagent_contract"

export interface SubagentPromptFrameInput {
  /** Absolute working directory the child operates in, when known. */
  cwd?: string
  /** `process.platform` style label, when known. */
  platform?: string
  /** Turn timestamp (ms). Drives the date line deterministically. */
  now?: number
  /**
   * Whether the child has been granted `dispatch_agent` (it runs below the
   * nesting cap). Decides which delegation sentence the contract carries.
   */
  canDelegate?: boolean
}

/**
 * The `<env>` block for a child: only the facts the caller could supply.
 * Returns `undefined` when nothing is known, so no empty element is emitted.
 */
export function buildSubagentEnvBlock(input: SubagentPromptFrameInput): string | undefined {
  const lines: string[] = []
  if (input.cwd) lines.push(`Working directory: ${input.cwd}`)
  if (input.platform) lines.push(`Platform: ${input.platform}`)
  if (typeof input.now === "number" && Number.isFinite(input.now)) {
    lines.push(`Today's date: ${new Date(input.now).toISOString().slice(0, 10)}`)
  }
  if (lines.length === 0) return undefined
  return ["<env>", ...lines, "</env>"].join("\n")
}

/** The contract a dispatched child works under, as a tagged block. */
export function buildSubagentContract(input: SubagentPromptFrameInput): string {
  const delegation = input.canDelegate
    ? "- You may hand a clearly separable sub-task to a subagent with `dispatch_agent`, but do the work yourself whenever that is faster. Never delegate the whole task back out."
    : "- You cannot dispatch subagents of your own. Do the work yourself with the tools you have."
  const paths = input.cwd
    ? "- Work inside the working directory above and resolve every relative path against it. Do not write files elsewhere."
    : undefined
  return [
    `<${SUBAGENT_CONTRACT_TAG}>`,
    "You are running as a subagent dispatched by another agent to complete one delegated task.",
    "- The dispatcher reads ONLY your final message. Your intermediate steps, tool calls, and partial text are invisible to it. End with a complete, self-contained report: what you did, what you found (with concrete file paths, identifiers, and line numbers where relevant), and what remains uncertain.",
    "- There is no follow-up turn and you cannot ask the dispatcher questions. When the task is ambiguous, state the assumption you chose and proceed with the most reasonable interpretation instead of stopping.",
    "- Stay within the task you were given. Do not widen its scope or make changes it did not ask for.",
    ...(paths ? [paths] : []),
    delegation,
    `</${SUBAGENT_CONTRACT_TAG}>`,
  ].join("\n")
}

/**
 * Compose a child's full system prompt: its identity prompt, then the
 * environment block, then the contract. An empty identity still gets the
 * frame, so an agent file with a one-line body behaves like a built-in.
 */
export function composeSubagentSystemPrompt(
  prompt: string | undefined,
  input: SubagentPromptFrameInput = {}
): string {
  const identity = (prompt ?? "").trim()
  if (identity.includes(`<${SUBAGENT_CONTRACT_TAG}>`)) return identity
  const env = buildSubagentEnvBlock(input)
  return [identity, env, buildSubagentContract(input)].filter(Boolean).join("\n\n")
}

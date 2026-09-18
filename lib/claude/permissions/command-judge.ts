/**
 * Small-model command-safety judge — the optional "model" tier of the agent
 * Auto-mode (`auto-mode.ts`).
 *
 * The deterministic classifier (`command-safety.ts`) handles the common cases
 * offline. When it is uncertain (`ask`) and the user has opted into the
 * `rules+model` mode, this module asks a cheap background model — the same
 * `LlmClient` the conversation-title generator uses
 * (`lib/ai/generation/utility-client.ts`) — whether the command is safe to run
 * unattended. This mirrors OpenClaw's optional AI safety check layered on top
 * of its allowlist.
 *
 * Privacy: the command is **never** sent to the model if it carries PII /
 * secrets (`hasNoLeakingPii`). Failures, malformed output, and PII all resolve
 * to `null` so the caller falls back to the safe default (prompt the user).
 * Results are cached by command string with a short TTL to avoid re-judging a
 * command the agent runs repeatedly in a turn.
 */

import type { LlmClient } from "@/lib/twin/distill/llm"
import { extractJson } from "@/lib/twin/distill/llm"
import { hasNoLeakingPii } from "@cognia/redact"

export type RiskLevel = "low" | "medium" | "high"

export interface CommandJudgement {
  /** Whether the command is safe to run without asking the user. */
  safe: boolean
  /** Coarse risk band, used by `denyOnHighRisk`. */
  risk: RiskLevel
  /** Short model-supplied rationale. */
  reason: string
}

export interface JudgeOptions {
  /** Working directory hint included in the prompt for context. */
  cwd?: string
  /** UI locale so the rationale matches the user (e.g. "zh-CN"). */
  locale?: string
  /**
   * Scope the verdict to the instruction context it was reached under (the
   * session id in practice). A mid-turn steer supersedes that context —
   * {@link invalidateJudgeContext} bumps the context's epoch, so a command the
   * running turn retries after a redirect is judged fresh instead of silently
   * reusing the "safe" verdict the previous instruction produced.
   */
  contextKey?: string
}

const CACHE_TTL_MS = 5 * 60 * 1000
const MAX_CACHE = 200

interface CacheEntry {
  at: number
  value: CommandJudgement | null
}
const cache = new Map<string, CacheEntry>()

/**
 * Per-context judgement epoch, embedded in the cache key. Bumping it orphans
 * every verdict cached under the context in O(1) — the stale entries then age
 * out on TTL/`evict` rather than needing a scan.
 */
const contextEpochs = new Map<string, number>()

/**
 * Invalidate every verdict cached under a context. Call when a new user
 * instruction reaches the session (a live or queued steer): the commands the
 * turn goes on to run are judged under the new instruction, not the one the
 * verdict was cached for. Compaction deliberately does NOT call this — review
 * evidence is meant to survive a context boundary.
 */
export function invalidateJudgeContext(contextKey: string): void {
  if (!contextKey) return
  contextEpochs.set(contextKey, (contextEpochs.get(contextKey) ?? 0) + 1)
}

function cacheKey(command: string, contextKey: string | undefined): string {
  if (!contextKey) return command
  return `${contextKey}#${contextEpochs.get(contextKey) ?? 0}::${command}`
}

/** Test seam — clear the memoization cache and every context epoch. */
export function __resetJudgeCache(): void {
  cache.clear()
  contextEpochs.clear()
}

const SYSTEM_PROMPT =
  "You are a security gate for a coding agent's shell. Decide whether a single " +
  "shell command is safe to execute WITHOUT asking the human for confirmation. " +
  "Treat as UNSAFE: deleting or overwriting data, modifying system/global state, " +
  "changing permissions or users, downloading-and-executing code, exfiltrating " +
  "data, irreversible or privileged operations. Treat as SAFE: read-only " +
  "inspection, builds, tests, linters, and local edits a developer routinely runs. " +
  'Respond with ONLY a JSON object: {"safe": boolean, "risk": "low"|"medium"|"high", ' +
  '"reason": "<=12 words"}. No prose, no code fences.'

function coerceRisk(value: unknown, safe: boolean): RiskLevel {
  if (value === "low" || value === "medium" || value === "high") return value
  // Unknown / missing: a safe verdict is low risk, an unsafe one is high.
  return safe ? "low" : "high"
}

function evict(): void {
  if (cache.size <= MAX_CACHE) return
  const oldest = [...cache.entries()].sort((a, b) => a[1].at - b[1].at)[0]
  if (oldest) cache.delete(oldest[0])
}

/**
 * Ask the small model whether `command` is safe to run unattended. Returns
 * `null` (never throws) when the command is empty, carries PII, the model
 * fails, or the output can't be parsed — the caller treats `null` as "fall
 * back to the deterministic verdict / prompt the user".
 */
export async function judgeCommandSafety(
  client: LlmClient,
  command: string,
  opts: JudgeOptions = {}
): Promise<CommandJudgement | null> {
  const trimmed = (command ?? "").trim()
  if (!trimmed) return null

  const key = cacheKey(trimmed, opts.contextKey)
  const cached = cache.get(key)
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.value

  // Never send a command carrying secrets / PII to the model.
  if (!hasNoLeakingPii(trimmed)) return null

  let result: CommandJudgement | null = null
  try {
    const localeHint = opts.locale ? `\nReply language: ${opts.locale}` : ""
    const cwdHint = opts.cwd ? `\nWorking directory: ${opts.cwd}` : ""
    const text = await client.complete(`Command:\n${trimmed}${cwdHint}${localeHint}`, {
      system: SYSTEM_PROMPT,
      temperature: 0,
      maxTokens: 80,
    })
    const raw = extractJson<{ safe?: unknown; risk?: unknown; reason?: unknown }>(text)
    if (typeof raw.safe !== "boolean") {
      result = null
    } else {
      result = {
        safe: raw.safe,
        risk: coerceRisk(raw.risk, raw.safe),
        reason: typeof raw.reason === "string" ? raw.reason.slice(0, 160) : "",
      }
    }
  } catch {
    result = null
  }

  cache.set(key, { at: Date.now(), value: result })
  evict()
  return result
}

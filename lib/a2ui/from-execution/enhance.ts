/**
 * Optional LLM enhancement for the execution-page bridge (the "hybrid" half).
 *
 * The deterministic projectors always produce a complete, schema-valid page.
 * This pass adds a natural-language executive summary on top — and ONLY a
 * summary: we never ask the model to emit A2UI components (which could violate
 * the schema). The model returns plain text + optional bullet insights, which
 * the caller wraps into a guaranteed-valid Card. So enhancement can never break
 * rendering; on any failure it returns `null` and the baseline stands.
 *
 * Safety: the source digest is PII-gated (`hasNoLeakingPii` → `redactText` →
 * re-gate) before it leaves the device. If it still leaks after redaction, we
 * skip the call entirely rather than send it.
 */

import { buildUtilityLlmClient } from "@/lib/ai/generation/utility-client"
import type { AppSettings, ChatSession } from "@/lib/claude/types"
import { hasNoLeakingPii, redactText } from "@cognia/redact"
import { loggers } from "@cognia/logging"

const SYSTEM_PROMPT =
  "You are a concise analyst. Given a digest of an automated execution " +
  "(a workflow run or a chat conversation), write a short executive summary " +
  "for a teammate who did not watch it run. Respond with STRICT JSON only, no " +
  'markdown fences, shaped: {"title": string, "summary": string, "insights": string[]}. ' +
  "`summary` is 1-3 sentences. `insights` is 0-4 short bullet strings (bottlenecks, " +
  "failures, notable outputs). Do not invent facts not present in the digest."

export interface ExecutionPageEnhancement {
  /** A refined human title for the page (may be empty). */
  title?: string
  /** 1-3 sentence executive summary. */
  summary: string
  /** Short bullet insights. */
  insights: string[]
}

export interface EnhanceExecutionPageArgs {
  /** Plain-text digest of the source (built by the caller, PII-gated here). */
  digest: string
  /** Session used for provider/model resolution (null for non-chat sources). */
  session: ChatSession | null | undefined
  appSettings: AppSettings | null | undefined
  abortSignal?: AbortSignal
}

/** Strip an accidental ```json fence and parse, tolerating a bare summary. */
export function parseEnhancementResponse(raw: string): ExecutionPageEnhancement | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  const unfenced = trimmed
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim()
  try {
    const parsed = JSON.parse(unfenced) as Partial<ExecutionPageEnhancement>
    const summary = typeof parsed.summary === "string" ? parsed.summary.trim() : ""
    if (!summary) return null
    return {
      title: typeof parsed.title === "string" ? parsed.title.trim() : undefined,
      summary,
      insights: Array.isArray(parsed.insights)
        ? parsed.insights
            .filter((i): i is string => typeof i === "string" && i.trim().length > 0)
            .map((i) => i.trim())
        : [],
    }
  } catch {
    // Not JSON — treat the whole response as the summary (still useful).
    return { summary: unfenced, insights: [] }
  }
}

/** Run the digest through the PII gate. Returns safe text, or null if it can't be made safe. */
export function sanitizeDigest(digest: string): string | null {
  const trimmed = digest.trim()
  if (!trimmed) return null
  if (hasNoLeakingPii(trimmed)) return trimmed
  const redacted = redactText(trimmed).redacted
  return hasNoLeakingPii(redacted) ? redacted : null
}

/**
 * Generate an optional executive summary for an execution page. Never throws;
 * returns `null` when disabled, blocked by the PII gate, unresolvable to a
 * client, or on any provider error.
 */
export async function enhanceExecutionPage(
  args: EnhanceExecutionPageArgs
): Promise<ExecutionPageEnhancement | null> {
  const safeDigest = sanitizeDigest(args.digest)
  if (!safeDigest) return null

  const client = buildUtilityLlmClient({
    session: args.session,
    appSettings: args.appSettings,
    featureId: "a2ui.interactive-page",
  })
  if (!client) return null

  try {
    const response = await client.complete(safeDigest, {
      system: SYSTEM_PROMPT,
      temperature: 0,
      maxTokens: 400,
      abortSignal: args.abortSignal,
    })
    return parseEnhancementResponse(response)
  } catch (error) {
    loggers.a2ui.warn("a2ui interactive-page enhancement failed", { error: String(error) })
    return null
  }
}

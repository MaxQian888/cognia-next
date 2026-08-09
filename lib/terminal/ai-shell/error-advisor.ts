/**
 * Error advisor for the AI Shell.
 *
 * When a step in the execution plan fails, the error advisor is invoked to:
 *  1. Diagnose what likely went wrong (from the exit code + output snippet)
 *  2. Suggest a fix command (or explain why a fix isn't possible)
 *
 * Like the plan generator, it uses the LlmClient and PII-gates the context.
 */

import { hasNoLeakingPii } from "@cognia/redact"
import type { LlmClient } from "@/lib/twin/distill/llm"
import { extractJson } from "@/lib/twin/distill/llm"
import type { ExecutionStep, ErrorAdvisory, AiShellContext } from "./types"

/** System prompt for error diagnosis. */
export function buildErrorAdvisorSystemPrompt(): string {
  return `You are a terminal error diagnosis assistant. Given a failed command and its output, explain what went wrong and suggest a fix.

RULES:
1. Be concise — one or two sentences for diagnosis.
2. If you can suggest a fix command, provide it as a single executable shell command.
3. Indicate whether the original command should be retried after the fix.
4. If no fix is possible (e.g., permission issue requiring manual action), set suggestedFix to null.

RESPONSE FORMAT — respond with ONLY a JSON object (no markdown fences):
{
  "diagnosis": "Brief explanation of what went wrong",
  "suggestedFix": "fix command" or null,
  "retryAfterFix": true/false
}`
}

/** Build the user prompt for error diagnosis. */
export function buildErrorAdvisorPrompt(
  step: ExecutionStep,
  context: Pick<AiShellContext, "cwd" | "shell" | "platform">
): string {
  const parts: string[] = []
  parts.push(`## Failed Command`)
  parts.push(`\`${step.command}\``)
  parts.push("")
  if (step.exitCode !== null) {
    parts.push(`Exit code: ${step.exitCode}`)
  }
  if (step.outputSnippet) {
    parts.push(`\nOutput:\n\`\`\`\n${step.outputSnippet}\n\`\`\``)
  }
  parts.push("")
  parts.push(`## Context`)
  if (context.cwd) parts.push(`- CWD: ${context.cwd}`)
  parts.push(`- Shell: ${context.shell}`)
  parts.push(`- Platform: ${context.platform}`)
  return parts.join("\n")
}

/** Raw response shape from the LLM. */
interface RawErrorAdvisoryResponse {
  diagnosis: string
  suggestedFix: string | null
  retryAfterFix: boolean
}

/** Validate the raw LLM response. */
function validateAdvisory(raw: unknown): raw is RawErrorAdvisoryResponse {
  if (!raw || typeof raw !== "object") return false
  const obj = raw as Record<string, unknown>
  return (
    typeof obj.diagnosis === "string" &&
    (obj.suggestedFix === null || typeof obj.suggestedFix === "string") &&
    typeof obj.retryAfterFix === "boolean"
  )
}

export interface ErrorAdvisorDeps {
  /** Resolve the LlmClient. Returns null if no model is configured. */
  getClient: () => LlmClient | null
  /** PII gate. Defaults to `hasNoLeakingPii`. */
  isPiiSafe?: (text: string) => boolean
}

/**
 * Get an error advisory for a failed step.
 *
 * @returns An ErrorAdvisory with diagnosis and optional fix, or null if
 *   the advisor cannot help (no client, PII issue, parse failure).
 */
export async function getErrorAdvisory(
  step: ExecutionStep,
  context: Pick<AiShellContext, "cwd" | "shell" | "platform">,
  deps: ErrorAdvisorDeps,
  signal?: AbortSignal
): Promise<ErrorAdvisory | null> {
  if (signal?.aborted) return null

  const client = deps.getClient()
  if (!client) return null

  const isPiiSafe = deps.isPiiSafe ?? hasNoLeakingPii
  const system = buildErrorAdvisorSystemPrompt()
  const prompt = buildErrorAdvisorPrompt(step, context)

  // PII gate
  if (!isPiiSafe(prompt)) return null

  try {
    const rawText = await client.complete(prompt, {
      system,
      temperature: 0.2,
      maxTokens: 512,
      abortSignal: signal,
    })

    if (signal?.aborted) return null

    const raw = extractJson<unknown>(rawText)
    if (!validateAdvisory(raw)) return null

    return {
      stepIndex: step.index,
      diagnosis: raw.diagnosis.trim(),
      suggestedFix: raw.suggestedFix?.trim() ?? null,
      retryAfterFix: raw.retryAfterFix,
    }
  } catch {
    return null
  }
}

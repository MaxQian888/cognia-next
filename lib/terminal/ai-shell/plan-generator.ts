/**
 * Plan generator for the AI Shell.
 *
 * Takes a user intent (natural language) + terminal context and calls the
 * LLM to produce a structured `ExecutionPlan` — a sequence of shell commands
 * to achieve the goal.
 *
 * Design notes:
 *  - Uses `LlmClient.stream` when available for progressive rendering
 *  - Falls back to `LlmClient.complete` + JSON extraction
 *  - PII-gates the assembled prompt before any model call
 *  - Structured output is parsed from JSON embedded in the response
 */

import { hasNoLeakingPii } from "@cognia/redact"
import type { LlmClient } from "@/lib/twin/distill/llm"
import { extractJson } from "@/lib/twin/distill/llm"
import type {
  AiShellContext,
  ExecutionPlan,
  ExecutionStep,
  PlanGeneratorOptions,
  PlanStreamCallback,
} from "./types"

/** Max steps the model is allowed to produce. */
export const DEFAULT_MAX_STEPS = 20

/** The system prompt for plan generation. */
export function buildPlanSystemPrompt(maxSteps: number): string {
  return `You are an expert terminal command planner. Given a user's intent and their current terminal context, generate a step-by-step execution plan of shell commands.

RULES:
1. Each step must be a single, executable shell command.
2. Order steps so earlier steps set up dependencies for later steps.
3. Mark steps as requiresConfirmation: true if they are destructive (rm -rf, force push, drop database, etc.), involve network calls to production systems, or modify global system state.
4. Keep descriptions concise (one line) — explain what the command does, not how.
5. Maximum ${maxSteps} steps per plan.
6. If the intent is unclear or unsafe, return an empty steps array with a brief explanation in the "reasoning" field.
7. Adapt to the user's shell (bash/zsh/fish/pwsh differ in syntax).
8. Use the working directory context — don't cd unnecessarily if already there.
9. Consider the recent command history to avoid redundant steps.

RESPONSE FORMAT — respond with ONLY a JSON object (no markdown fences, no commentary):
{
  "reasoning": "Brief explanation of your plan",
  "steps": [
    {
      "command": "the shell command",
      "description": "what this step does",
      "requiresConfirmation": false
    }
  ]
}

If you cannot fulfill the request (dangerous, nonsensical, or requires information you don't have), respond with:
{
  "reasoning": "explanation of why",
  "steps": []
}`
}

/** Build the user-facing prompt that includes context + intent. */
export function buildPlanUserPrompt(intent: string, ctx: AiShellContext): string {
  const parts: string[] = []
  parts.push(`## Terminal Context`)
  if (ctx.cwd) parts.push(`- Working directory: ${ctx.cwd}`)
  parts.push(`- Shell: ${ctx.shell}`)
  parts.push(`- Platform: ${ctx.platform}`)
  if (ctx.gitBranch) parts.push(`- Git branch: ${ctx.gitBranch}`)
  if (ctx.recentCommands.length > 0) {
    parts.push(`- Recent commands: ${ctx.recentCommands.slice(-5).join(" → ")}`)
  }
  if (ctx.recentOutput) {
    // Only include last 10 lines to keep prompt compact
    const outputTail = ctx.recentOutput.split("\n").slice(-10).join("\n")
    parts.push(`- Recent output (last lines):\n\`\`\`\n${outputTail}\n\`\`\``)
  }
  parts.push("")
  parts.push(`## User Intent`)
  parts.push(intent)
  return parts.join("\n")
}

/** Raw plan response from the LLM before normalization. */
interface RawPlanResponse {
  reasoning?: string
  steps: Array<{
    command: string
    description?: string
    requiresConfirmation?: boolean
  }>
}

/** Normalize a raw step into a proper ExecutionStep. */
function normalizeStep(
  raw: { command: string; description?: string; requiresConfirmation?: boolean },
  index: number
): ExecutionStep {
  return {
    index,
    command: raw.command.trim(),
    description: raw.description?.trim() ?? "",
    status: "pending",
    exitCode: null,
    outputSnippet: null,
    requiresConfirmation: raw.requiresConfirmation ?? false,
  }
}

/** Validate a raw plan response has the expected shape. */
function validateRawPlan(raw: unknown): raw is RawPlanResponse {
  if (!raw || typeof raw !== "object") return false
  const obj = raw as Record<string, unknown>
  if (!Array.isArray(obj.steps)) return false
  return obj.steps.every(
    (s: unknown) =>
      typeof s === "object" &&
      s !== null &&
      typeof (s as Record<string, unknown>).command === "string"
  )
}

export interface PlanGeneratorDeps {
  /** Resolve the LlmClient. Returns null if no model is configured. */
  getClient: () => LlmClient | null
  /** PII gate. Defaults to `hasNoLeakingPii`. */
  isPiiSafe?: (text: string) => boolean
  /** ID generator for plans. Defaults to a simple counter + timestamp. */
  generateId?: () => string
}

let idCounter = 0

function defaultGenerateId(): string {
  return `plan-${Date.now()}-${++idCounter}`
}

/**
 * Generate an execution plan from the user's intent and terminal context.
 *
 * @returns The complete ExecutionPlan, or a plan with status "error" on failure.
 */
export async function generatePlan(
  intent: string,
  context: AiShellContext,
  deps: PlanGeneratorDeps,
  options?: PlanGeneratorOptions,
  onStream?: PlanStreamCallback
): Promise<ExecutionPlan> {
  const generateId = deps.generateId ?? defaultGenerateId
  const isPiiSafe = deps.isPiiSafe ?? hasNoLeakingPii
  const maxSteps = options?.maxSteps ?? DEFAULT_MAX_STEPS
  const signal = options?.signal

  const planId = generateId()
  const now = Date.now()

  // Signal already aborted?
  if (signal?.aborted) {
    return { id: planId, intent, steps: [], status: "cancelled", createdAt: now }
  }

  // Resolve the LLM client
  const client = deps.getClient()
  if (!client) {
    return {
      id: planId,
      intent,
      steps: [],
      status: "error",
      error: "No LLM client available. Configure a model in settings.",
      createdAt: now,
    }
  }

  // Build prompts
  const system = buildPlanSystemPrompt(maxSteps)
  const prompt = buildPlanUserPrompt(intent, context)

  // PII gate
  if (!isPiiSafe(prompt)) {
    return {
      id: planId,
      intent,
      steps: [],
      status: "error",
      error:
        "Context contains sensitive information (API keys, credentials, etc.). Redact before retrying.",
      createdAt: now,
    }
  }

  // Notify stream listeners that generation started
  onStream?.({ id: planId, intent, steps: [], status: "generating", createdAt: now })

  try {
    let rawText: string

    // Prefer streaming if available — future UI can show partial plan
    if (client.stream) {
      const chunks: string[] = []
      for await (const delta of client.stream(prompt, {
        system,
        temperature: 0.3,
        maxTokens: 2048,
        abortSignal: signal,
      })) {
        if (signal?.aborted) {
          return { id: planId, intent, steps: [], status: "cancelled", createdAt: now }
        }
        chunks.push(delta)
      }
      rawText = chunks.join("")
    } else {
      rawText = await client.complete(prompt, {
        system,
        temperature: 0.3,
        maxTokens: 2048,
        abortSignal: signal,
      })
    }

    if (signal?.aborted) {
      return { id: planId, intent, steps: [], status: "cancelled", createdAt: now }
    }

    // Parse the structured response
    const raw = extractJson<unknown>(rawText)
    if (!validateRawPlan(raw)) {
      return {
        id: planId,
        intent,
        steps: [],
        status: "error",
        error: "Model returned invalid plan structure.",
        createdAt: now,
      }
    }

    const steps = raw.steps.slice(0, maxSteps).map((s, i) => normalizeStep(s, i))

    const plan: ExecutionPlan = {
      id: planId,
      intent,
      steps,
      status: steps.length > 0 ? "ready" : "error",
      error: steps.length === 0 ? (raw.reasoning ?? "No steps generated.") : undefined,
      createdAt: now,
    }

    onStream?.(plan)
    return plan
  } catch (err) {
    if (signal?.aborted) {
      return { id: planId, intent, steps: [], status: "cancelled", createdAt: now }
    }
    return {
      id: planId,
      intent,
      steps: [],
      status: "error",
      error: err instanceof Error ? err.message : "Unknown error during plan generation.",
      createdAt: now,
    }
  }
}

/** Reset the internal id counter (for testing). */
export function __resetPlanIdCounterForTesting(): void {
  idCounter = 0
}

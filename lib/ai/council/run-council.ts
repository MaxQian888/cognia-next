/**
 * Council — fan one prompt out to several models ("councillors") in parallel,
 * then have a synthesizer model merge their answers into a single consensus
 * response with an agreement/confidence summary.
 *
 * Ported from oh-my-opencode-slim (`src/council/council-manager.ts`,
 * `src/agents/council.ts`) and adapted to cognia: councillors and the
 * synthesizer are addressed by ROUTING ALIASES (ADR-0043), so each call reuses
 * the same provider-routing engine the chat path uses — `runRoutedPrompt`
 * handles fallback chains, circuit breakers, and usage/cost telemetry.
 *
 * Both the `/council` slash command and the `ai.council` workflow node call
 * this one function. The synthesizer step is injectable (`deps.runPrompt`) so
 * the suite runs without touching real providers.
 */

export type CouncilConfidence = "unanimous" | "majority" | "split" | "unknown"

export interface CouncillorSpec {
  /** Display name for this councillor (e.g. "alpha", "reviewer"). */
  name: string
  /** Routing alias resolved through the model-mapping registry. */
  modelAlias: string
  /** Optional role/steering prompt prepended to the user prompt. */
  systemPrompt?: string
}

export interface CouncilOptions {
  prompt: string
  councillors: CouncillorSpec[]
  /** Routing alias for the synthesizer model. */
  synthesizerAlias: string
  /** Extra synthesis guidance appended to the built-in instructions. */
  synthesisInstructions?: string
  /** Per-councillor timeout (ms). Default 180000 (omo-slim default). */
  timeoutMs?: number
  /** `parallel` (default) launches all councillors at once; `serial` one at a time. */
  executionMode?: "parallel" | "serial"
  /** Max concurrent councillors in parallel mode. Default 4. */
  maxConcurrency?: number
}

export interface CouncillorResult {
  name: string
  model: string
  status: "completed" | "failed"
  text?: string
  error?: string
}

export interface CouncilResult {
  /** The synthesizer's full markdown report (Response / Details / Summary). */
  markdown: string
  /** Best-effort consensus rating parsed from the synthesis (never thrown on). */
  confidence: CouncilConfidence
  councillors: CouncillorResult[]
  respondedCount: number
  totalCount: number
  synthesizerModel?: string
  synthesizerProvider?: string
}

export interface RunPromptInput {
  modelAlias: string
  userPrompt: string
  systemPrompt?: string
  temperature?: number
}

export interface RunPromptOutput {
  completion: string
  provider?: string
  model?: string
}

export interface RunCouncilDeps {
  /** Execute one routed prompt. Injected in tests; defaults to the routing engine. */
  runPrompt: (input: RunPromptInput) => Promise<RunPromptOutput>
  log?: (level: "info" | "warn", message: string) => void
}

const DEFAULT_TIMEOUT_MS = 180_000
const DEFAULT_CONCURRENCY = 4

/** The synthesizer's system prompt — adapted from omo-slim's COUNCIL_AGENT_PROMPT. */
export const COUNCIL_SYNTHESIS_SYSTEM = `You are the Council synthesizer. Several models ("councillors") \
independently answered the same prompt. Merge their answers into one superior response.

Synthesis process (follow in order):
1. Read the original prompt.
2. Review each councillor's response individually — note each one's key insight by name.
3. Identify agreements and contradictions between councillors.
4. Resolve contradictions with explicit reasoning — do not just average; choose the best approach and improve on it.
5. Produce the output in the required format below.

Required output format (use these exact section headings):

## Council Response
The best synthesized answer. Integrate the strongest points, resolve disagreements, give a clear final recommendation with concrete details / code where relevant.

## Councillor Details
Each councillor's response separately, under a "### <name>" heading, using the exact names provided. Note any that failed or timed out.

## Council Summary
Where councillors agreed, where they disagreed, why you chose the final answer, and remaining uncertainty. End with a consensus confidence rating on its own line: "Confidence: unanimous", "Confidence: majority", or "Confidence: split".`

/** Prepend an optional role prompt to the user's question (omo-slim format). */
export function formatCouncillorPrompt(userPrompt: string, councillorPrompt?: string): string {
  if (!councillorPrompt) return userPrompt
  return `${councillorPrompt}\n\n---\n\n${userPrompt}`
}

/** Build the synthesizer's user message from councillor results. */
export function formatCouncillorResults(
  originalPrompt: string,
  results: CouncillorResult[]
): string {
  const completed = results.filter((r) => r.status === "completed" && r.text)
  const failed = results.filter((r) => r.status !== "completed")

  if (completed.length === 0) {
    const details = results
      .map((r) => `**${r.name}** (${r.model}): ${r.status} — ${r.error ?? "Unknown"}`)
      .join("\n")
    return `---\n\n**Original Prompt**:\n${originalPrompt}\n\n---\n\n**Councillor Responses**:\nAll councillors failed to produce output:\n${details}\n\nAnswer the original prompt directly.`
  }

  const section = completed.map((r) => `**${r.name}** (${r.model}):\n${r.text}`).join("\n\n")
  let prompt = `---\n\n**Original Prompt**:\n${originalPrompt}\n\n---\n\n**Councillor Responses**:\n${section}`
  if (failed.length > 0) {
    const failedSection = failed
      .map((r) => `**${r.name}**: ${r.status} — ${r.error ?? "Unknown"}`)
      .join("\n")
    prompt += `\n\n---\n\n**Failed/Timed-out Councillors**:\n${failedSection}`
  }
  return prompt
}

/** Best-effort parse of the consensus rating out of synthesized markdown. */
export function parseConfidence(markdown: string): CouncilConfidence {
  const m = /confidence[^\n]{0,40}?\b(unanimous|majority|split)\b/i.exec(markdown)
  return m ? (m[1].toLowerCase() as CouncilConfidence) : "unknown"
}

/** Run `fn` over `items` with at most `limit` in flight; failures reject the chain. */
async function mapLimited<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const width = Math.max(1, Math.min(limit, items.length || 1))
  const worker = async () => {
    for (;;) {
      const i = next++
      if (i >= items.length) return
      results[i] = await fn(items[i] as T, i)
    }
  }
  await Promise.all(Array.from({ length: width }, () => worker()))
  return results
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  if (!ms || ms <= 0) return p
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`councillor timed out after ${ms}ms`)), ms)
    p.then(
      (v) => {
        clearTimeout(t)
        resolve(v)
      },
      (e) => {
        clearTimeout(t)
        reject(e)
      }
    )
  })
}

/** Run one councillor, never throwing — failures become a `failed` result. */
async function runCouncillor(
  spec: CouncillorSpec,
  prompt: string,
  timeoutMs: number,
  deps: RunCouncilDeps
): Promise<CouncillorResult> {
  try {
    const out = await withTimeout(
      deps.runPrompt({
        modelAlias: spec.modelAlias,
        userPrompt: formatCouncillorPrompt(prompt, spec.systemPrompt),
      }),
      timeoutMs
    )
    const text = (out.completion ?? "").trim()
    if (!text) {
      return {
        name: spec.name,
        model: out.model ?? spec.modelAlias,
        status: "failed",
        error: "empty response",
      }
    }
    return { name: spec.name, model: out.model ?? spec.modelAlias, status: "completed", text }
  } catch (err) {
    deps.log?.(
      "warn",
      `councillor "${spec.name}" failed: ${err instanceof Error ? err.message : String(err)}`
    )
    return {
      name: spec.name,
      model: spec.modelAlias,
      status: "failed",
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

/**
 * Run a full council: fan out councillors, then synthesize. Throws only on
 * invalid input or when the synthesizer call itself fails.
 */
export async function runCouncil(
  opts: CouncilOptions,
  deps: RunCouncilDeps
): Promise<CouncilResult> {
  const prompt = (opts.prompt ?? "").trim()
  if (!prompt) throw new Error("runCouncil: prompt is required")
  if (!Array.isArray(opts.councillors) || opts.councillors.length === 0) {
    throw new Error("runCouncil: at least one councillor is required")
  }
  if (!opts.synthesizerAlias) throw new Error("runCouncil: synthesizerAlias is required")

  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const concurrency =
    opts.executionMode === "serial" ? 1 : (opts.maxConcurrency ?? DEFAULT_CONCURRENCY)

  deps.log?.(
    "info",
    `council: ${opts.councillors.length} councillors (${opts.executionMode ?? "parallel"})`
  )

  const councillors = await mapLimited(opts.councillors, concurrency, (spec) =>
    runCouncillor(spec, prompt, timeoutMs, deps)
  )

  const respondedCount = councillors.filter((c) => c.status === "completed").length

  const synthSystem = opts.synthesisInstructions
    ? `${COUNCIL_SYNTHESIS_SYSTEM}\n\nAdditional guidance:\n${opts.synthesisInstructions}`
    : COUNCIL_SYNTHESIS_SYSTEM

  const synth = await deps.runPrompt({
    modelAlias: opts.synthesizerAlias,
    systemPrompt: synthSystem,
    userPrompt: formatCouncillorResults(prompt, councillors),
    temperature: 0.1,
  })

  const markdown = (synth.completion ?? "").trim()
  return {
    markdown,
    confidence: parseConfidence(markdown),
    councillors,
    respondedCount,
    totalCount: councillors.length,
    synthesizerModel: synth.model,
    synthesizerProvider: synth.provider,
  }
}

/**
 * Production `runPrompt` backed by the ADR-0043 routing engine. Built lazily so
 * importing this module never touches stores (mirrors `ai-prompt-routed`).
 */
export async function defaultCouncilRunPrompt(): Promise<RunCouncilDeps["runPrompt"]> {
  const { runRoutedPrompt, defaultRoutedPromptDeps } =
    await import("@/lib/workflow/nodes/ai/ai-prompt-routed")
  const routedDeps = await defaultRoutedPromptDeps()
  return async (input: RunPromptInput): Promise<RunPromptOutput> => {
    const out = await runRoutedPrompt(
      {
        modelAlias: input.modelAlias,
        userPrompt: input.userPrompt,
        systemPrompt: input.systemPrompt,
        temperature: input.temperature,
        log: () => {},
      },
      routedDeps
    )
    return { completion: out.completion, provider: out.provider, model: out.model }
  }
}

/** Render a compact chat-facing markdown report (used by the `/council` command). */
export function renderCouncilReport(result: CouncilResult): string {
  const footer =
    `\n\n---\n*Council: ${result.respondedCount}/${result.totalCount} councillors responded` +
    `${result.synthesizerModel ? ` · synthesized by ${result.synthesizerModel}` : ""}` +
    `${result.confidence !== "unknown" ? ` · ${result.confidence}` : ""}*`
  return `${result.markdown}${footer}`
}

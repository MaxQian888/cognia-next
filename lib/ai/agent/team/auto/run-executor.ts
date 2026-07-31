/**
 * Non-team executor bindings for the orchestration dispatcher.
 *
 * When `chooseExecutor` picks `council` or `ensemble`, the proposal isn't a
 * team — there's no roster/DAG to materialize. These helpers bind the
 * (PII-redacted) `proposal.objective` to the existing `runCouncil` / `runEnsemble`
 * engines using the configured routing aliases, and return a chat-facing
 * markdown report. This is the single place council/ensemble are wired to a
 * proposal, shared by the GUI dialog and the CLI controller.
 *
 * Pure-ish: all model access is injected via {@link RunExecutorDeps} so callers
 * (and tests) supply their own routed-prompt runner and alias source.
 */

import { runCouncil, renderCouncilReport, type RunCouncilDeps } from "@/lib/ai/council/run-council"
import { resolveCouncilRoster } from "@/lib/slash-commands/actions/council"
import {
  runEnsemble,
  type EnsembleSampleResult,
  type RunEnsembleDeps,
} from "@/lib/ai/ensemble/run-ensemble"
import type { AutoOrchestrationProposal } from "./types"

export interface RunExecutorDeps {
  /** Enabled routing aliases available to convene / sample. */
  loadAliases: () => Promise<string[]>
  /** Routed prompt runner (councillors, samples, synthesizer). */
  runPrompt: RunCouncilDeps["runPrompt"]
  log?: (level: "info" | "warn", message: string) => void
}

/** Common result shape: a chat-facing report + whether it actually ran. */
export interface ExecutorRunResult {
  markdown: string
  ok: boolean
}

/**
 * Convene a council over the proposal's objective. Reuses `resolveCouncilRoster`
 * so an unconfigured user gets the same clear "no aliases" message the
 * `/council` command surfaces.
 */
export async function runCouncilFromProposal(
  proposal: AutoOrchestrationProposal,
  deps: RunExecutorDeps
): Promise<ExecutorRunResult> {
  const aliases = await deps.loadAliases()
  const roster = resolveCouncilRoster({ prompt: proposal.objective }, aliases)
  if ("error" in roster) return { markdown: roster.error, ok: false }

  const result = await runCouncil(
    {
      prompt: proposal.objective,
      councillors: roster.councillors,
      synthesizerAlias: roster.synthesizerAlias,
    },
    { runPrompt: deps.runPrompt, ...(deps.log ? { log: deps.log } : {}) }
  )
  return { markdown: renderCouncilReport(result), ok: true }
}

/** Default sample count for verification ensembles. */
const DEFAULT_ENSEMBLE_N = 3

/** Format ensemble samples into a synthesis prompt (parallels the council synth). */
function formatSamplesForSynthesis(samples: EnsembleSampleResult[]): string {
  const completed = samples.filter((s) => s.status === "completed" && s.text)
  const blocks = completed.map((s, i) => `### Sample ${i + 1}\n${s.text}`)
  return blocks.join("\n\n")
}

/**
 * Run a verification ensemble: sample the objective N times through the first
 * available routing alias, then synthesize one answer. Returns a markdown report.
 */
export async function runEnsembleFromProposal(
  proposal: AutoOrchestrationProposal,
  deps: RunExecutorDeps,
  opts?: { n?: number }
): Promise<ExecutorRunResult> {
  const aliases = await deps.loadAliases()
  if (aliases.length === 0) {
    return {
      markdown: "No models to sample. Configure model-mapping aliases in Settings → Routing first.",
      ok: false,
    }
  }
  const sampleAlias = aliases[0]
  const synthAlias = aliases.find((a) => a !== sampleAlias) ?? sampleAlias
  const n = Math.max(1, opts?.n ?? DEFAULT_ENSEMBLE_N)

  const ensembleDeps: RunEnsembleDeps = {
    runSample: async () => {
      const out = await deps.runPrompt({ modelAlias: sampleAlias, userPrompt: proposal.objective })
      return { text: out.completion }
    },
    synthesize: async (samples, instructions) => {
      const body = formatSamplesForSynthesis(samples)
      const out = await deps.runPrompt({
        modelAlias: synthAlias,
        userPrompt:
          `Synthesize a single best answer from these ${samples.length} independent samples ` +
          `for the task below.${instructions ? ` ${instructions}` : ""}\n\n` +
          `## Task\n${proposal.objective}\n\n## Samples\n${body}`,
      })
      return { text: out.completion }
    },
    ...(deps.log ? { log: deps.log } : {}),
  }

  const result = await runEnsemble(
    { n, aggregation: { kind: "synthesize-by-final-agent" } },
    ensembleDeps
  )
  const answer = typeof result.result === "string" ? result.result : String(result.result ?? "")
  const footer = `\n\n---\n*Ensemble: ${result.respondedCount}/${result.totalCount} samples responded · synthesized*`
  return { markdown: `${answer}${footer}`, ok: true }
}

/**
 * Browser/desktop wiring for the matrix runner. Assembles the real
 * {@link RunConfiguredDeps}: Dexie loaders + savers (incl. version snapshot and
 * per-case results), the three target dep sets, and the scorer set. When a
 * renderer-side judge client resolves it adds the L3 judge + RAG scorers
 * (cross-model — the judge client is built independently of the target model);
 * otherwise it falls back to the deterministic tier only and flags
 * `deterministicOnly` so the UI can say so.
 */

import type { AppSettings, ChatSession } from "@cognia/agent-config-types"
import { buildRendererLlmClient } from "@/lib/ai/renderer-llm-client"
import { getDataset, listCases } from "@/lib/db/eval-datasets"
import { saveRun } from "@/lib/db/eval-runs"
import { snapshotVersion } from "@/lib/db/eval-dataset-versions"
import { saveCaseResult } from "@/lib/db/eval-run-cases"
import { deterministicScorers, llmScorers } from "@cognia/eval-core"
import { resolveEvalSettings } from "./settings"
import { defaultChatTargetDeps } from "./targets/chat"
import { defaultTeamTargetDeps } from "./targets/team-default-deps"
import { defaultWorkflowTargetDeps } from "./targets/workflow-default-deps"
import { createTargetFromSpec } from "./targets/create-from-spec"
import type { RunConfiguredDeps } from "./run-config"

export interface BrowserRunDepsArgs {
  appSettings: AppSettings | null
  session?: ChatSession | null
  /** Override the judge model (cross-model). Defaults to the resolver's choice. */
  judgeModel?: string
  /**
   * Skip the LLM judge entirely — run the deterministic tier only, even if a
   * judge client would otherwise resolve. Surfaces the settings "deterministic
   * only" toggle down to the scorer wiring.
   */
  forceDeterministic?: boolean
}

function newEvalRunId(): string {
  return "evrun_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8)
}

export interface ConfiguredRunDepsResult {
  deps: RunConfiguredDeps
  /** True when no judge client resolved — only deterministic scorers run. */
  deterministicOnly: boolean
}

/**
 * Wire the {@link RunConfiguredDeps} for the matrix runner: real Dexie
 * loaders / savers (incl. version snapshot + per-case results), the three
 * target dep sets behind {@link createTargetFromSpec}, and the deterministic
 * (+ optional cross-model judge) scorer set.
 */
export function buildConfiguredRunDeps(args: BrowserRunDepsArgs): ConfiguredRunDepsResult {
  const client = args.forceDeterministic
    ? null
    : buildRendererLlmClient({
        session: args.session ?? null,
        appSettings: args.appSettings,
        featureId: "eval-judge",
        ...(args.judgeModel ? { modelOverride: args.judgeModel } : {}),
      })
  const allScorers = client
    ? [...deterministicScorers(), ...llmScorers({ client })]
    : deterministicScorers()

  const targetDeps = {
    chat: defaultChatTargetDeps(),
    team: defaultTeamTargetDeps(),
    workflow: defaultWorkflowTargetDeps(),
  }

  return {
    deterministicOnly: !client,
    deps: {
      loadDataset: getDataset,
      loadCases: listCases,
      snapshot: snapshotVersion,
      buildTarget: (spec) => createTargetFromSpec(spec, targetDeps),
      allScorers,
      saveRun,
      saveCaseResult,
      now: () => Date.now(),
      newRunId: newEvalRunId,
      maxStoredOutputChars: resolveEvalSettings(args.appSettings).maxStoredOutputChars,
    },
  }
}

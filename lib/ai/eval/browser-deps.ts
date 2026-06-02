/**
 * Browser/desktop wiring for the run controller. Assembles the real
 * {@link RunControllerDeps}: Dexie loaders + saver, the chat target driving the
 * sidecar, and the scorer set. When a renderer-side judge client resolves it
 * adds the L3 judge + RAG scorers (cross-model — the judge client is built
 * independently of the target model); otherwise it falls back to the
 * deterministic tier only and flags `deterministicOnly` so the UI can say so.
 */

import type { AppSettings, ChatSession } from "@/lib/claude/types"
import { buildRendererLlmClient } from "@/lib/ai/renderer-llm-client"
import { getDataset, listCases } from "@/lib/db/eval-datasets"
import { saveRun } from "@/lib/db/eval-runs"
import { snapshotVersion } from "@/lib/db/eval-dataset-versions"
import { saveCaseResult } from "@/lib/db/eval-run-cases"
import { deterministicScorers, llmScorers } from "./scorers"
import { createChatTarget, defaultChatTargetDeps } from "./targets/chat"
import { defaultTeamTargetDeps } from "./targets/team-default-deps"
import { defaultWorkflowTargetDeps } from "./targets/workflow-default-deps"
import { createTargetFromSpec } from "./targets/create-from-spec"
import type { RunControllerDeps } from "./run-controller"
import type { RunConfiguredDeps } from "./run-config"

export interface BrowserRunDepsArgs {
  appSettings: AppSettings | null
  session?: ChatSession | null
  /** Override the judge model (cross-model). Defaults to the resolver's choice. */
  judgeModel?: string
}

export interface BrowserRunDepsResult {
  deps: RunControllerDeps
  /** True when no judge client resolved — only deterministic scorers run. */
  deterministicOnly: boolean
}

export function buildBrowserRunDeps(args: BrowserRunDepsArgs): BrowserRunDepsResult {
  const model = args.session?.model ?? args.appSettings?.defaultModel ?? "claude-opus-4-8"
  const target = createChatTarget({ label: model, model }, defaultChatTargetDeps())

  const client = buildRendererLlmClient({
    session: args.session ?? null,
    appSettings: args.appSettings,
    featureId: "eval-judge",
    ...(args.judgeModel ? { modelOverride: args.judgeModel } : {}),
  })

  const scorers = client
    ? [...deterministicScorers(), ...llmScorers({ client })]
    : deterministicScorers()

  return {
    deterministicOnly: !client,
    deps: {
      loadDataset: getDataset,
      loadCases: listCases,
      saveRun,
      scorers,
      target,
      now: () => Date.now(),
      newRunId: newEvalRunId,
    },
  }
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
  const client = buildRendererLlmClient({
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
    },
  }
}

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
import { deterministicScorers, llmScorers } from "./scorers"
import { createChatTarget, defaultChatTargetDeps } from "./targets/chat"
import type { RunControllerDeps } from "./run-controller"

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
      newRunId: () =>
        "evrun_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8),
    },
  }
}

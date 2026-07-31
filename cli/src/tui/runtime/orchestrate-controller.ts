/**
 * `/orchestrate <objective> [--consensus] [--verify]` controller.
 *
 * Analyzes an objective (reusing `planAutoOrchestration` — PII gate → routing
 * assessment → roster → tasks), chooses a concrete executor via the dispatcher,
 * then either RUNS it (council / ensemble / single analysis prompt, shown in the
 * scrollable document pager) or, for team-shaped executors, previews the plan
 * and defers execution to the desktop (the CLI has no renderer-side team
 * runtime — same boundary as `/team auto`).
 *
 * `--consensus` opts into a council; `--verify` into a verification ensemble.
 * Reuses the same client/settings/alias seams as `/team auto` and `/council`.
 * CLI is English-only; system messages are plain strings by repo convention.
 */
import {
  planAutoOrchestration,
  AutoOrchestrationPiiError,
} from "@/lib/ai/agent/team/auto/auto-orchestrate"
import type { ConsensusSignal } from "@/lib/ai/agent/team/auto/dispatch-executor"
import {
  runCouncilFromProposal,
  runEnsembleFromProposal,
  type RunExecutorDeps,
} from "@/lib/ai/agent/team/auto/run-executor"
import { renderProposalDoc } from "@/lib/ai/agent/team/auto/preview-doc"
import { buildRendererLlmClient } from "@/lib/ai/renderer-llm-client"
import { defaultCouncilRunPrompt } from "@/lib/ai/council/run-council"
import type { AppSettings, ChatSession } from "@cognia/agent-config-types"
import type { LlmClient } from "@/lib/twin/distill/llm"
import { getSession } from "@/lib/db/sessions"

import { ensureCliDb } from "../../db/bootstrap"
import type { ResolvedConfig } from "../../config/schema"
import type { TuiAction } from "../state/types"
import { resolveAppSettings } from "./goal-controller"
import { errorMessage, truncate } from "./shared"

export interface OrchestrateDeps {
  dispatch: (action: TuiAction) => void
  config: ResolvedConfig
  sessionId: string
  signal?: AbortSignal
  ensureDb?: () => Promise<unknown>
  resolveSettings?: (sessionId: string, config: ResolvedConfig) => AppSettings | null
  getSession?: (id: string) => Promise<ChatSession | null | undefined>
  buildClient?: (
    session: ChatSession | null | undefined,
    appSettings: AppSettings | null
  ) => LlmClient | null
  plan?: typeof planAutoOrchestration
  /** Enabled routing aliases (defaults to the shared Dexie settings). */
  loadAliases?: () => Promise<string[]>
  /** Routed prompt runner (defaults to the ADR-0043 routing engine). */
  runPrompt?: RunExecutorDeps["runPrompt"]
}

const USAGE = [
  "Usage: /orchestrate <objective> — analyze a task and run the best multi-model shape.",
  "",
  "Optional flags:",
  "- --consensus — convene a council of models and synthesize a consensus",
  "- --verify — run a verification ensemble (N samples + synthesis)",
].join("\n")

export interface ParsedOrchestrateArgs {
  objective: string
  signal: ConsensusSignal
}

/** Extract `--consensus` / `--verify` flags; the remainder is the objective. */
export function parseOrchestrateArgs(raw: string): ParsedOrchestrateArgs {
  let rest = raw ?? ""
  const signal: ConsensusSignal = {}
  if (/(^|\s)--consensus(\s|$)/.test(rest)) {
    signal.consensusNeeded = true
    rest = rest.replace(/(^|\s)--consensus(\s|$)/, " ")
  }
  if (/(^|\s)--verify(\s|$)/.test(rest)) {
    signal.verificationNeeded = true
    rest = rest.replace(/(^|\s)--verify(\s|$)/, " ")
  }
  return { objective: rest.replace(/\s+/g, " ").trim(), signal }
}

/** Default alias source: enabled model-mapping aliases from the shared settings. */
async function loadConfiguredAliases(): Promise<string[]> {
  const { getSettings } = await import("@/lib/db/settings")
  const settings = await getSettings()
  const mappings = Array.isArray(settings.modelMappings) ? settings.modelMappings : []
  return mappings.filter((m) => m && m.enabled !== false && m.alias).map((m) => m.alias)
}

export async function orchestrateRun(rawArgs: string, deps: OrchestrateDeps): Promise<void> {
  const parsed = parseOrchestrateArgs(rawArgs ?? "")
  if (!parsed.objective) {
    deps.dispatch({ type: "NOTICE", message: USAGE })
    return
  }

  await (deps.ensureDb ?? (() => ensureCliDb()))()
  const appSettings = (deps.resolveSettings ?? resolveAppSettings)(deps.sessionId, deps.config)
  const session = await (deps.getSession ?? getSession)(deps.sessionId)
  const client = (
    deps.buildClient ??
    ((s, a) => buildRendererLlmClient({ session: s, appSettings: a, featureId: "agent-team-auto" }))
  )(session, appSettings)
  if (!client) {
    deps.dispatch({
      type: "NOTICE",
      message:
        "Orchestrate needs a provider with a renderer-side API key — configure one in settings.",
    })
    return
  }

  let proposal
  try {
    proposal = await (deps.plan ?? planAutoOrchestration)({
      objective: parsed.objective,
      client,
      consensusSignal: parsed.signal,
      ...(deps.signal ? { signal: deps.signal } : {}),
    })
  } catch (err) {
    const message =
      err instanceof AutoOrchestrationPiiError
        ? "Orchestrate refused: the objective still contains sensitive data after redaction."
        : `Orchestrate failed: ${errorMessage(err)}`
    deps.dispatch({ type: "NOTICE", message })
    return
  }

  const kind = proposal.executor?.kind ?? "team-flat"

  // Team-shaped / handoff executors need the renderer-only team runtime — the
  // CLI can't run them, so preview the plan and defer. The footer tells the
  // operator what approving on the desktop will actually do per kind.
  if (kind === "team-flat" || kind === "team-ultracode" || kind.endsWith("-handoff")) {
    const footer =
      kind === "background-handoff"
        ? "_Preview only — approve this plan on the desktop, where it will be queued as a one-shot scheduler task and run in the background (you'll get a completion notification)._"
        : kind === "external-handoff"
          ? "_Preview only — approve on the desktop to mark the team awaiting external pickup; an external CLI agent can then claim it via the Cognia bridge (team_list / team_run)._"
          : "_Preview only — materialize and run this team from the desktop app._"
    const body = `${renderProposalDoc(proposal)}\n\n---\n${footer}`
    deps.dispatch({
      type: "OVERLAY_OPEN",
      overlay: { kind: "document", title: "Orchestrate", body, format: "markdown" },
    })
    return
  }

  // Analysis executors run right here.
  deps.dispatch({ type: "ACTIVITY_START", kind: "council", label: truncate(parsed.objective) })
  try {
    const runPrompt = deps.runPrompt ?? (await defaultCouncilRunPrompt())
    const execDeps: RunExecutorDeps = {
      loadAliases: deps.loadAliases ?? loadConfiguredAliases,
      runPrompt,
      log: (_level, message) => deps.dispatch({ type: "ACTIVITY_PROGRESS", note: message }),
    }
    let body: string
    let title: string
    if (kind === "council") {
      title = "Orchestrate · Council"
      body = (await runCouncilFromProposal(proposal, execDeps)).markdown
    } else if (kind === "ensemble") {
      title = "Orchestrate · Ensemble"
      body = (await runEnsembleFromProposal(proposal, execDeps)).markdown
    } else {
      // single-send: run the objective once through the top routing alias.
      title = "Orchestrate · Single agent"
      const aliases = await execDeps.loadAliases()
      if (aliases.length === 0) {
        body =
          "No models configured. Add a routing alias in Settings → Routing, or send the objective directly in chat."
      } else {
        const out = await runPrompt({ modelAlias: aliases[0], userPrompt: proposal.objective })
        body = out.completion
      }
    }
    deps.dispatch({
      type: "OVERLAY_OPEN",
      overlay: { kind: "document", title, body, format: "markdown" },
    })
    deps.dispatch({ type: "ACTIVITY_END", status: "done" })
  } catch (err) {
    deps.dispatch({ type: "NOTICE", message: `Orchestrate failed: ${errorMessage(err)}` })
    deps.dispatch({ type: "ACTIVITY_END", status: "error" })
  }
}

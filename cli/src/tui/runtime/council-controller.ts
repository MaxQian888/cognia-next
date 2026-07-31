/**
 * `/council <question>` controller — run a multi-model consensus from the TUI.
 *
 * Fans the question out to several councillor models (routing aliases, ADR-0043),
 * then a synthesizer merges them into one answer with a confidence rating, and
 * drops the report into the scrollable document pager. Reuses the desktop engine
 * (`runCouncil` + `renderCouncilReport`) and the pure arg/roster helpers
 * (`parseCouncilArgs` / `resolveCouncilRoster`) verbatim — the CLI only had them
 * unwired. Aliases come from the shared Dexie settings, reachable here via
 * `ensureCliDb()` (installs the `window` + IndexedDB shims + restores the
 * `~/.cognia/db.json` snapshot), same as `/goal` and `/loop`.
 *
 * CLI is English-only; system messages are plain strings by repo convention.
 */
import {
  runCouncil,
  renderCouncilReport,
  defaultCouncilRunPrompt,
  type RunCouncilDeps,
} from "@/lib/ai/council/run-council"
import { parseCouncilArgs, resolveCouncilRoster } from "@/lib/slash-commands/actions/council"

import { ensureCliDb } from "../../db/bootstrap"
import { errorMessage, truncate } from "./shared"
import type { TuiAction } from "../state/types"

export interface CouncilDeps {
  dispatch: (action: TuiAction) => void
  signal?: AbortSignal
  /** Open the CLI-local db before reading `modelMappings`. Defaults to
   * {@link ensureCliDb}; injected as a no-op in tests. */
  ensureDb?: () => Promise<unknown>
  /** Enabled routing aliases available to convene as councillors. Defaults to the
   * shared Dexie `settings.modelMappings` (mirrors the GUI `handleCouncil`). */
  loadAliases?: () => Promise<string[]>
  /** Routed prompt runner. Defaults to the ADR-0043 routing engine. */
  runPrompt?: RunCouncilDeps["runPrompt"]
  /** Council engine seam (defaults to {@link runCouncil}). */
  run?: typeof runCouncil
}

const USAGE = [
  "Usage: /council <question> — ask several models and synthesize a consensus.",
  "",
  "Optional flags:",
  "- --models alias1,alias2,alias3 — councillor model aliases (defaults to your configured routing aliases)",
  "- --synth alias — synthesizer model alias",
].join("\n")

/** Default alias source: enabled model-mapping aliases from the shared settings. */
async function loadConfiguredAliases(): Promise<string[]> {
  const { getSettings } = await import("@/lib/db/settings")
  const settings = await getSettings()
  const mappings = Array.isArray(settings.modelMappings) ? settings.modelMappings : []
  return mappings.filter((m) => m && m.enabled !== false && m.alias).map((m) => m.alias)
}

export async function councilRun(rawArgs: string, deps: CouncilDeps): Promise<void> {
  const parsed = parseCouncilArgs(rawArgs ?? "")
  if (!parsed.prompt) {
    deps.dispatch({ type: "NOTICE", message: USAGE })
    return
  }

  await (deps.ensureDb ?? (() => ensureCliDb()))()
  const aliases = await (deps.loadAliases ?? loadConfiguredAliases)()
  const roster = resolveCouncilRoster(parsed, aliases)
  if ("error" in roster) {
    deps.dispatch({ type: "NOTICE", message: roster.error })
    return
  }

  deps.dispatch({ type: "ACTIVITY_START", kind: "council", label: truncate(parsed.prompt) })
  try {
    const runPrompt = deps.runPrompt ?? (await defaultCouncilRunPrompt())
    const run = deps.run ?? runCouncil
    const result = await run(
      {
        prompt: parsed.prompt,
        councillors: roster.councillors,
        synthesizerAlias: roster.synthesizerAlias,
      },
      {
        runPrompt,
        log: (_level, message) => deps.dispatch({ type: "ACTIVITY_PROGRESS", note: message }),
      }
    )
    deps.dispatch({
      type: "OVERLAY_OPEN",
      overlay: {
        kind: "document",
        title: "Council",
        body: renderCouncilReport(result),
        format: "markdown",
      },
    })
    deps.dispatch({ type: "ACTIVITY_END", status: "done" })
  } catch (err) {
    deps.dispatch({ type: "NOTICE", message: `Council failed: ${errorMessage(err)}` })
    deps.dispatch({ type: "ACTIVITY_END", status: "error" })
  }
}

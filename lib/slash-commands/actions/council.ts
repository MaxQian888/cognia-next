/**
 * `/council <prompt>` — run a multi-model consensus from the main chat.
 *
 * Fans the prompt out to several councillor models (routing aliases), then a
 * synthesizer model merges them into one answer with a confidence rating, and
 * drops the report into the transcript. Shares `runCouncil` with the
 * `ai.council` workflow node.
 *
 * Model selection (no new settings schema — reuses the configured routing
 * aliases, ADR-0043):
 *   - `--models a,b,c` picks councillor aliases explicitly;
 *   - `--synth alias` picks the synthesizer;
 *   - otherwise the enabled model-mapping aliases are used (first few as
 *     councillors, a distinct one as synthesizer).
 *
 * Output strings are plain English by repo convention (slash-command system
 * messages aren't next-intl-localized — see `actions/run-saved-workflow.ts`).
 */

import type { SlashContext } from "../builtin"
import {
  runCouncil,
  renderCouncilReport,
  defaultCouncilRunPrompt,
  type CouncillorSpec,
  type RunCouncilDeps,
} from "@/lib/ai/council/run-council"

/** Max councillors auto-selected from configured aliases. */
const AUTO_COUNCILLOR_LIMIT = 3

export interface ParsedCouncilArgs {
  prompt: string
  models?: string[]
  synth?: string
}

/** Extract `--models a,b,c` and `--synth alias`; the remainder is the prompt. */
export function parseCouncilArgs(raw: string): ParsedCouncilArgs {
  let rest = raw ?? ""
  let models: string[] | undefined
  let synth: string | undefined

  const modelsMatch = /--models\s+(\S+)/.exec(rest)
  if (modelsMatch) {
    models = modelsMatch[1]
      .split(",")
      .map((m) => m.trim())
      .filter(Boolean)
    rest = rest.replace(modelsMatch[0], " ")
  }
  const synthMatch = /--synth\s+(\S+)/.exec(rest)
  if (synthMatch) {
    synth = synthMatch[1].trim()
    rest = rest.replace(synthMatch[0], " ")
  }
  return { prompt: rest.replace(/\s+/g, " ").trim(), models, synth }
}

/**
 * Resolve councillor specs + synthesizer alias from parsed args and the set of
 * available aliases. Returns null with a reason when there isn't enough to run.
 */
export function resolveCouncilRoster(
  parsed: ParsedCouncilArgs,
  availableAliases: string[]
): { councillors: CouncillorSpec[]; synthesizerAlias: string } | { error: string } {
  const available = availableAliases.filter(Boolean)
  let councillorAliases = parsed.models?.length
    ? parsed.models
    : available.slice(0, AUTO_COUNCILLOR_LIMIT)
  councillorAliases = Array.from(new Set(councillorAliases))

  if (councillorAliases.length === 0) {
    return {
      error:
        "No models to convene. Configure model-mapping aliases in Settings → Routing, or pass " +
        "`/council --models alias1,alias2 <prompt>`.",
    }
  }

  let synthesizerAlias = parsed.synth
  if (!synthesizerAlias) {
    // Prefer a configured alias not already a councillor; else reuse the first.
    synthesizerAlias = available.find((a) => !councillorAliases.includes(a)) ?? councillorAliases[0]
  }

  const councillors: CouncillorSpec[] = councillorAliases.map((alias) => ({
    name: alias,
    modelAlias: alias,
  }))
  return { councillors, synthesizerAlias }
}

export interface CouncilCommandDeps {
  /** Enabled routing aliases available to convene as councillors. */
  loadAliases: () => Promise<string[]>
  /** Routed prompt runner (councillors + synthesizer). */
  runPrompt: RunCouncilDeps["runPrompt"]
}

/** Testable core. `handleCouncil` wraps this with production deps. */
export async function executeCouncilCommand(
  ctx: SlashContext,
  deps: CouncilCommandDeps
): Promise<void> {
  if (ctx.chatStatus === "streaming" || ctx.chatStatus === "awaiting_approval") {
    ctx.pushSystemMessage(
      "Can't run a council while a turn is in progress. Try again once it settles."
    )
    return
  }

  const parsed = parseCouncilArgs(ctx.args)
  if (!parsed.prompt) {
    ctx.pushSystemMessage(
      [
        "Usage: `/council <question>` — ask several models and synthesize a consensus.",
        "",
        "Optional flags:",
        "- `--models alias1,alias2,alias3` — councillor model aliases (defaults to your configured routing aliases)",
        "- `--synth alias` — synthesizer model alias",
      ].join("\n")
    )
    return
  }

  const aliases = await deps.loadAliases()
  const roster = resolveCouncilRoster(parsed, aliases)
  if ("error" in roster) {
    ctx.pushSystemMessage(roster.error)
    return
  }

  ctx.pushSystemMessage(
    `Convening a council of ${roster.councillors.length} (${roster.councillors
      .map((c) => c.modelAlias)
      .join(", ")}) → synthesized by ${roster.synthesizerAlias}…`
  )

  try {
    const result = await runCouncil(
      {
        prompt: parsed.prompt,
        councillors: roster.councillors,
        synthesizerAlias: roster.synthesizerAlias,
      },
      { runPrompt: deps.runPrompt }
    )
    ctx.pushSystemMessage(renderCouncilReport(result))
  } catch (err) {
    ctx.pushSystemMessage(`Council failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/** Production handler registered as the `/council` action command. */
export async function handleCouncil(ctx: SlashContext): Promise<void> {
  await executeCouncilCommand(ctx, {
    loadAliases: async () => {
      const { getSettings } = await import("@/lib/db/settings")
      const settings = await getSettings()
      const mappings = Array.isArray(settings.modelMappings) ? settings.modelMappings : []
      return mappings.filter((m) => m && m.enabled !== false && m.alias).map((m) => m.alias)
    },
    runPrompt: await defaultCouncilRunPrompt(),
  })
}

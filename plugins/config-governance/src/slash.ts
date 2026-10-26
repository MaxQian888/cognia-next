/**
 * `/governance [audit|adherence|open]` — the command-line way in. `audit`
 * runs the audit and answers with the report, `adherence` replays the checks
 * (deriving them first when there are none), `open` and no argument open the
 * view.
 */
import type { PluginCommandContext, PluginCommandResult } from "@cognia/plugin-sdk"

import { renderAdherenceReport, renderAuditReport, type Translate } from "./engine/report"
import type { GovernanceRuntime } from "./runtime/runtime"

export type GovernanceSubcommand = "audit" | "adherence" | "open"

export function parseGovernanceArgs(args: readonly string[]): GovernanceSubcommand | null {
  const first = (args[0] ?? "").toLowerCase()
  if (!first || first === "open") return "open"
  if (first === "audit" || first === "adherence") return first
  return null
}

export interface SlashDeps {
  runtime: GovernanceRuntime
  t: Translate
  openView(): Promise<void>
  sessionWorkspace(sessionId: string): Promise<string | null>
}

export async function handleGovernanceCommand(
  deps: SlashDeps,
  args: readonly string[],
  context?: PluginCommandContext
): Promise<PluginCommandResult> {
  const sub = parseGovernanceArgs(args)
  if (!sub) return { handled: true, message: deps.t("slash.usage") }
  if (sub === "open") {
    await deps.openView()
    return { handled: true }
  }
  const workspaceId =
    (context?.sessionId ? await deps.sessionWorkspace(context.sessionId) : null) ??
    (await deps.runtime.defaultWorkspace())
  try {
    if (sub === "audit") {
      const run = await deps.runtime.audit(workspaceId)
      const kept = await deps.runtime.store.keptFindings(workspaceId)
      return {
        handled: true,
        message: `${renderAuditReport(run, deps.t, kept)}\n\n${deps.t("slash.openHint")}`,
      }
    }
    let checks = await deps.runtime.store.checks(workspaceId)
    if (!checks) checks = await deps.runtime.deriveChecks(workspaceId)
    const adherence = await deps.runtime.backtest(workspaceId)
    return {
      handled: true,
      message: `${renderAdherenceReport(checks.checks, adherence?.results ?? [], adherence?.sessions ?? 0, deps.t)}\n\n${deps.t("slash.openHint")}`,
    }
  } catch (error) {
    return {
      handled: true,
      message: deps.t("slash.failed", {
        error: error instanceof Error ? error.message : String(error),
      }),
    }
  }
}

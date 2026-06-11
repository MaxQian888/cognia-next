/**
 * `/status` controller — opens a health + context panel. Reuses the doctor facts
 * (`collectDoctorFacts`) for provider/model/auth/credentials/store, the footer's
 * git reader, and the shared context-window math, so the panel never recomputes
 * anything the rest of the CLI already knows. Pure aside from the injected reads
 * collectDoctorFacts already owns.
 */
import { getModelContextWindow } from "@/lib/claude/usage"

import { collectDoctorFacts, type DoctorDeps } from "./doctor-controller"
import { contextPercent, contextTokens } from "../format/usage"
import { readGitBranch } from "../format/status-bar"
import type { StatusReport, TuiAction, UsageInfo } from "../state/types"

export interface StatusDeps extends DoctorDeps {
  /** Latest turn usage (drives the context gauge). */
  usage?: UsageInfo
  /** Git branch reader; defaults to reading `<cwd>/.git/HEAD`. */
  readBranch?: (cwd: string) => string | null
}

/** Assemble the status report (pure given the injected fs/credential reads). */
export function collectStatusReport(deps: StatusDeps): StatusReport {
  const facts = collectDoctorFacts(deps)
  const model = deps.config.model
  return {
    version: facts.version,
    provider: facts.provider,
    model: facts.model,
    modelValid: facts.modelValid,
    auth: facts.auth,
    credentialedProviders: facts.credentialedProviders,
    cwd: facts.cwd,
    gitBranch: (deps.readBranch ?? readGitBranch)(facts.cwd),
    contextPct: contextPercent(deps.usage, model),
    contextTokens: contextTokens(deps.usage),
    contextWindow: getModelContextWindow(model),
    dbSnapshotExists: facts.dbSnapshotExists,
  }
}

export function runStatus(deps: StatusDeps): void {
  const report = collectStatusReport(deps)
  deps.dispatch({ type: "OVERLAY_OPEN", overlay: { kind: "status", report } })
}

export type { TuiAction }

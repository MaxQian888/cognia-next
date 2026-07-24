/**
 * `/status` controller — opens a health + context panel. Reuses the doctor facts
 * (`collectDoctorFacts`) for provider/model/auth/credentials/store, the footer's
 * git reader, and the shared context-window math, so the panel never recomputes
 * anything the rest of the CLI already knows. Pure aside from the injected reads
 * collectDoctorFacts already owns.
 */
import { getModelContextWindow } from "@/lib/claude/usage"

import { resolveActiveModel } from "../../config/active-model"
import { collectDoctorFacts, type DoctorDeps } from "./doctor-controller"
import { contextPercent, contextTokens } from "../format/usage"
import { readGitBranch } from "../format/status-bar"
import { backendIdentity } from "./backend-identity"
import { buildCogniaParityReport } from "./cognia-parity-report"
import {
  BACKEND_FEATURE_LABELS,
  blockedFeatures,
  type BackendCapabilities,
} from "./backend-capabilities"
import type { StatusReport, TuiAction, UsageInfo } from "../state/types"

export interface StatusDeps extends DoctorDeps {
  /** The chat session id, so the panel can read that session's live Cognia
   * parity facts instead of describing the preset in the abstract. */
  sessionId?: string
  /** Injected in tests; defaults to the live tool-host registry. */
  readParity?: typeof buildCogniaParityReport
  /** What the active backend supports, for the blocked-feature summary. */
  capabilities?: BackendCapabilities
  /** Latest turn usage (drives the context gauge). */
  usage?: UsageInfo
  /** Per-model context window (from the catalog); falls back to the pattern table. */
  contextWindow?: number
  /** Git branch reader; defaults to reading `<cwd>/.git/HEAD`. */
  readBranch?: (cwd: string) => string | null
}

/** Assemble the status report (pure given the injected fs/credential reads). */
export function collectStatusReport(deps: StatusDeps): StatusReport {
  const facts = collectDoctorFacts(deps)
  const model = resolveActiveModel(deps.config)
  const window =
    deps.contextWindow && deps.contextWindow > 0 ? deps.contextWindow : getModelContextWindow(model)
  // Same preset the banner names, so the panel can never disagree with it.
  const identity = backendIdentity(deps.config, deps.capabilities?.presetId)
  const parity = deps.sessionId
    ? (deps.readParity ?? buildCogniaParityReport)(deps.sessionId)
    : undefined
  return {
    version: facts.version,
    agentBackend: facts.agentBackend,
    ...(parity ? { cogniaParity: parity } : {}),
    ...(deps.capabilities
      ? {
          blockedFeatures: blockedFeatures(deps.capabilities).map(
            (feature) => BACKEND_FEATURE_LABELS[feature]
          ),
        }
      : {}),
    // The identity the rest of the UI shows — the backend, not the built-in
    // provider it would otherwise borrow.
    provider: identity.provider,
    model: identity.model ?? facts.model,
    modelValid: facts.modelValid,
    auth: facts.auth,
    credentialedProviders: facts.credentialedProviders,
    cwd: facts.cwd,
    gitBranch: (deps.readBranch ?? readGitBranch)(facts.cwd),
    contextPct: contextPercent(deps.usage, model, window),
    contextTokens: contextTokens(deps.usage),
    contextWindow: window,
    dbSnapshotExists: facts.dbSnapshotExists,
  }
}

export function runStatus(deps: StatusDeps): void {
  const report = collectStatusReport(deps)
  deps.dispatch({ type: "OVERLAY_OPEN", overlay: { kind: "status", report } })
}

export type { TuiAction }

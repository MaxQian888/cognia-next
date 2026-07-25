/**
 * `/status` controller — opens a health + context panel. Reuses the doctor facts
 * (`collectDoctorFacts`) for provider/model/auth/credentials/store, the footer's
 * git reader, and the shared context-window math, so the panel never recomputes
 * anything the rest of the CLI already knows. Pure aside from the injected reads
 * collectDoctorFacts already owns.
 */
import { collectDoctorFacts, type DoctorDeps } from "./doctor-controller"
import { contextPercent, contextTokens } from "../format/usage"
import { readGitBranch } from "../format/status-bar"
import { backendContextWindow, backendIdentity } from "./backend-identity"
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
  // Same preset the banner names, so the panel can never disagree with it.
  const presetId = deps.capabilities?.presetId
  const identity = backendIdentity(deps.config, presetId)
  // The gauge must describe the model that actually answers. It used to be sized
  // from `resolveActiveModel` — the built-in provider's view — so on
  // `--backend codex` the panel reported an Anthropic window and a percentage
  // derived from it while Codex was answering. Absent means "no honest number
  // for this agent"; the panel renders the raw token count and no gauge.
  const window = backendContextWindow(deps.config, deps.contextWindow, presetId)
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
    // `facts.model` is the built-in provider's resolved model, which is only the
    // right answer on the built-in agent. An external agent we never named a
    // model for runs its own choice from its own config file.
    model: identity.model ?? (identity.external ? "(agent default)" : facts.model),
    // The catalog `facts.modelValid` checks is the built-in provider's, so on an
    // external backend it would be grading a model the panel isn't even showing.
    // There is no catalog to fail against there — never flag it.
    modelValid: identity.external ? true : facts.modelValid,
    auth: facts.auth,
    credentialedProviders: facts.credentialedProviders,
    cwd: facts.cwd,
    gitBranch: (deps.readBranch ?? readGitBranch)(facts.cwd),
    ...(window ? { contextPct: contextPercent(deps.usage, identity.model, window) } : {}),
    contextTokens: contextTokens(deps.usage),
    ...(window ? { contextWindow: window } : {}),
    dbSnapshotExists: facts.dbSnapshotExists,
  }
}

export function runStatus(deps: StatusDeps): void {
  const report = collectStatusReport(deps)
  deps.dispatch({ type: "OVERLAY_OPEN", overlay: { kind: "status", report } })
}

export type { TuiAction }

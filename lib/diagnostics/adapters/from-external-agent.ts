/**
 * `ExternalAgentValiditySnapshot` → diagnostic inputs.
 *
 * Builds on `lib/diagnostics/external-agent-reason.ts` (the reason-code table)
 * by folding in the two pieces of remediation the snapshot already carries and
 * nothing rendered: the ecosystem's `docsUrl` and the recovery-hint key ids.
 *
 * The docs link is the difference between "Missing prerequisite" and "Missing
 * prerequisite — here is how to install it", which for a per-ecosystem external
 * agent is most of the value.
 */

import type { DiagnosticAction, DiagnosticCode, DiagnosticMeta } from "@cognia/diagnostics"
import type { ExternalAgentValiditySnapshot } from "@/types/agent/external-agent"

import { diagnosticCodeForReason } from "../external-agent-reason"

export interface ExternalAgentDiagnosis {
  code: DiagnosticCode
  message: string
  /** Appended after the registry defaults. */
  actions: readonly DiagnosticAction[]
  meta: DiagnosticMeta
  /** i18n key ids under `diagnostics.recoveryHint.*`, for the renderer. */
  recoveryHintKeys: readonly string[]
}

/**
 * Diagnose an external-agent validity snapshot.
 *
 * Returns `null` when the snapshot reports a healthy agent (`ok`, or no reason
 * code at all) — nothing to tell the user.
 */
export function diagnoseExternalAgent(
  snapshot: ExternalAgentValiditySnapshot | undefined,
  agentId?: string
): ExternalAgentDiagnosis | null {
  if (!snapshot) return null

  const reasonCode = snapshot.canonicalReasonCode ?? snapshot.lastBranchReasonCode
  const code = diagnosticCodeForReason(reasonCode)
  if (!code) return null

  const actions: DiagnosticAction[] = []
  // `docsUrl` is per-ecosystem and is the only place install instructions live.
  const docsUrl = snapshot.ecosystem?.docsUrl
  if (docsUrl) actions.push({ kind: "open-external", url: docsUrl })
  if (agentId) {
    actions.push({ kind: "reconnect-external-agent", agentId })
  }

  const meta: DiagnosticMeta = {}
  if (agentId) meta.agentId = agentId
  if (snapshot.correlation?.sessionId) meta.sessionId = snapshot.correlation.sessionId
  if (snapshot.correlation?.turnId) meta.turnId = snapshot.correlation.turnId
  if (snapshot.correlation?.traceId) meta.traceId = snapshot.correlation.traceId
  if (reasonCode) meta.extra = { reasonCode }

  return {
    code,
    message: snapshot.canonicalReason ?? snapshot.lastBranchReason ?? "",
    actions,
    meta,
    recoveryHintKeys: snapshot.recoveryHints ?? [],
  }
}

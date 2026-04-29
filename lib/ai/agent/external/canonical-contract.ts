import type {
  ExternalAgentBenchmarkCapabilityEntry,
  ExternalAgentBranchOutcome,
  ExternalAgentBranchReasonCode,
  ExternalAgentCapabilitySnapshot,
  ExternalAgentEcosystemReadinessSnapshot,
  ExternalAgentExecutionEligibility,
  ExternalAgentLifecycleCompletenessStage,
  ExternalAgentSessionExtensionSupport,
  ExternalAgentValiditySnapshot,
} from "@/types/agent/external-agent"

export const EXTERNAL_AGENT_CANONICAL_CONTRACT_VERSION = 1

export function createUnknownSessionExtensionSupport(): ExternalAgentSessionExtensionSupport {
  return {
    "session/list": { state: "unknown" },
    "session/fork": { state: "unknown" },
    "session/resume": { state: "unknown" },
  }
}

function resolveCanonicalReasonCode(
  snapshot: Partial<ExternalAgentValiditySnapshot>
): ExternalAgentBranchReasonCode {
  if (
    !snapshot.canonicalReasonCode &&
    !snapshot.blockingReasonCode &&
    !snapshot.lastBranchReasonCode &&
    snapshot.executable === false
  ) {
    if (snapshot.ecosystem?.supportTier === "documented-only") {
      return "ecosystem_documented_only"
    }
    if (snapshot.ecosystem?.prerequisiteStatus === "action-required") {
      return "ecosystem_prerequisite_missing"
    }
  }

  return (
    snapshot.canonicalReasonCode ??
    snapshot.blockingReasonCode ??
    snapshot.lastBranchReasonCode ??
    "ok"
  )
}

function resolveCanonicalReason(
  snapshot: Partial<ExternalAgentValiditySnapshot>
): string | undefined {
  if (!snapshot.canonicalReason && !snapshot.blockingReason && !snapshot.lastBranchReason) {
    if (snapshot.ecosystem?.supportTier === "documented-only") {
      return (
        snapshot.ecosystem.limitationNote ??
        snapshot.ecosystem.recommendedActions?.[0] ??
        "This official surface is documented but not directly executable in Cognia yet."
      )
    }
    if (snapshot.ecosystem?.prerequisiteStatus === "action-required") {
      const missingPrerequisite = snapshot.ecosystem.prerequisites?.find(
        (item) => item.status === "missing"
      )
      return (
        missingPrerequisite?.detail ??
        missingPrerequisite?.label ??
        snapshot.ecosystem.recommendedActions?.[0]
      )
    }
  }

  return snapshot.canonicalReason ?? snapshot.blockingReason ?? snapshot.lastBranchReason
}

function resolveExecutionEligibility(
  snapshot: Partial<ExternalAgentValiditySnapshot>
): ExternalAgentExecutionEligibility {
  if (snapshot.executable !== undefined) {
    return snapshot.executable ? "eligible" : "blocked"
  }
  if (snapshot.executionEligibility) {
    return snapshot.executionEligibility
  }
  return "eligible"
}

function resolveBranchOutcome(
  reasonCode: ExternalAgentBranchReasonCode,
  eligibility: ExternalAgentExecutionEligibility,
  explicit?: ExternalAgentBranchOutcome
): ExternalAgentBranchOutcome {
  if (explicit) {
    return explicit
  }
  if (reasonCode === "strict_failure") {
    return "strict_failure"
  }
  if (reasonCode === "fallback_to_builtin") {
    return "fallback"
  }
  if (reasonCode === "agent_not_found" || reasonCode === "configuration_missing") {
    return "builtin"
  }
  return eligibility === "blocked" ? "blocked" : "external"
}

function mapSourceToLifecycleStage(
  source: ExternalAgentValiditySnapshot["source"],
  outcome: ExternalAgentBranchOutcome
): ExternalAgentLifecycleCompletenessStage {
  if (outcome === "fallback") {
    return "fallback"
  }
  if (outcome === "strict_failure") {
    return "recovery"
  }
  if (source === "config") {
    return "config"
  }
  if (source === "connect" || source === "health") {
    return "connect"
  }
  return "execution"
}

function resolveRecoveryHints(reasonCode: ExternalAgentBranchReasonCode): string[] {
  switch (reasonCode) {
    case "ecosystem_prerequisite_missing":
      return ["Complete the required external-agent setup, then retry the connection."]
    case "ecosystem_documented_only":
      return [
        "Use the linked official product workflow for this surface.",
        "Select an executable local surface in Cognia for direct connection.",
      ]
    case "protocol_unsupported":
      return ["Switch agent protocol to ACP.", "Re-save external-agent configuration."]
    case "transport_blocked":
      return ["Run Cognia in desktop (Tauri) runtime for stdio transport."]
    case "initialization_failed":
      return ["Check ACP process command and startup arguments.", "Retry after reconnect."]
    case "health_check_failed":
      return ["Inspect external-agent health endpoint/logs.", "Reconnect and retry."]
    case "extension_unsupported":
      return [
        "Use operations supported by this endpoint.",
        "Create a new session when resume/fork is unavailable.",
      ]
    case "session_resolution_failed":
      return ["Resume with an existing session id or allow new session creation."]
    case "permission_denied":
      return ["Adjust permission mode or approve required actions."]
    case "execution_failed":
      return ["Check runtime diagnostics and retry with scoped input."]
    default:
      return []
  }
}

function normalizeExternalAgentEcosystemReadiness(
  ecosystem?: ExternalAgentEcosystemReadinessSnapshot
): ExternalAgentEcosystemReadinessSnapshot | undefined {
  if (!ecosystem) {
    return undefined
  }

  return {
    ...ecosystem,
    prerequisites: ecosystem.prerequisites ?? [],
    recommendedActions: ecosystem.recommendedActions ?? [],
  }
}

export function normalizeExternalAgentValiditySnapshot(
  snapshot: Partial<ExternalAgentValiditySnapshot>,
  options?: {
    fallbackProtocol?: ExternalAgentCapabilitySnapshot["protocol"]
    fallbackSource?: ExternalAgentValiditySnapshot["source"]
  }
): ExternalAgentValiditySnapshot {
  const checkedAt = snapshot.checkedAt ?? new Date()
  const source = snapshot.source ?? options?.fallbackSource ?? "config"
  const sessionExtensions = snapshot.sessionExtensions ?? createUnknownSessionExtensionSupport()
  const ecosystem = normalizeExternalAgentEcosystemReadiness(snapshot.ecosystem)
  const reasonCode = resolveCanonicalReasonCode(snapshot)
  const reason = resolveCanonicalReason(snapshot)
  const executionEligibility = resolveExecutionEligibility(snapshot)
  const branchOutcome = resolveBranchOutcome(
    reasonCode,
    executionEligibility,
    snapshot.branchOutcome
  )
  const lifecycleStage = snapshot.lifecycleStage ?? mapSourceToLifecycleStage(source, branchOutcome)
  const blockedStage =
    snapshot.blockedStage ?? (executionEligibility === "blocked" ? lifecycleStage : undefined)
  const capabilitySnapshot: ExternalAgentCapabilitySnapshot = snapshot.capabilitySnapshot ?? {
    protocol: snapshot.negotiation?.protocol ?? options?.fallbackProtocol ?? "acp",
    authRequired: snapshot.negotiation?.authRequired,
    authMethods: snapshot.negotiation?.authMethods?.map((method) => method.id),
    hasAgentCapabilities: Boolean(snapshot.negotiation?.agentCapabilities),
    sessionExtensions,
  }
  const recoveryHints =
    snapshot.recoveryHints ??
    (ecosystem?.recommendedActions && ecosystem.recommendedActions.length > 0
      ? ecosystem.recommendedActions
      : resolveRecoveryHints(reasonCode))

  return {
    executable: snapshot.executable ?? executionEligibility === "eligible",
    checkedAt,
    source,
    blockingReasonCode: snapshot.blockingReasonCode,
    blockingReason: snapshot.blockingReason,
    healthStatus: snapshot.healthStatus ?? "unknown",
    lastHealthCheckAt: snapshot.lastHealthCheckAt,
    sessionExtensions,
    negotiation: snapshot.negotiation,
    lastBranchReasonCode: snapshot.lastBranchReasonCode,
    lastBranchReason: snapshot.lastBranchReason,
    lastBranchAt: snapshot.lastBranchAt,
    contractVersion: snapshot.contractVersion ?? EXTERNAL_AGENT_CANONICAL_CONTRACT_VERSION,
    lifecycleStage,
    blockedStage,
    executionEligibility,
    capabilitySnapshot,
    ecosystem,
    canonicalReasonCode: reasonCode,
    canonicalReason: reason,
    branchOutcome,
    correlation:
      snapshot.correlation ??
      (reason
        ? {
            source: "manager",
            observedAt: checkedAt,
          }
        : undefined),
    recoveryHints,
  }
}

export interface ExternalAgentBenchmarkValidationResult {
  valid: boolean
  errors: string[]
}

export function validateExternalAgentBenchmarkCapabilityEntry(
  entry: ExternalAgentBenchmarkCapabilityEntry
): ExternalAgentBenchmarkValidationResult {
  const errors: string[] = []

  if (entry.status === "validated" && entry.evidence.length === 0) {
    errors.push(`Capability "${entry.id}" is validated but has no executable evidence.`)
  }

  if (entry.status === "intentional-deviation") {
    if (!entry.deviation) {
      errors.push(
        `Capability "${entry.id}" is intentional-deviation but deviation record is missing.`
      )
    } else {
      if (!entry.deviation.rationale.trim()) {
        errors.push(`Capability "${entry.id}" deviation rationale is required.`)
      }
      if (!entry.deviation.tradeOff.trim()) {
        errors.push(`Capability "${entry.id}" deviation tradeOff is required.`)
      }
      if (!entry.deviation.userImpact.trim()) {
        errors.push(`Capability "${entry.id}" deviation userImpact is required.`)
      }
      if (!entry.deviation.review.reviewedBy.trim()) {
        errors.push(`Capability "${entry.id}" deviation review reviewer is required.`)
      }
      if (!(entry.deviation.review.reviewedAt instanceof Date)) {
        errors.push(`Capability "${entry.id}" deviation review timestamp is required.`)
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  }
}

export function validateExternalAgentBenchmarkCapabilityMap(
  entries: ExternalAgentBenchmarkCapabilityEntry[]
): ExternalAgentBenchmarkValidationResult {
  const errors: string[] = []
  for (const entry of entries) {
    const result = validateExternalAgentBenchmarkCapabilityEntry(entry)
    errors.push(...result.errors)
  }
  return {
    valid: errors.length === 0,
    errors,
  }
}

export function createExternalAgentBenchmarkBaseline(
  now = new Date()
): ExternalAgentBenchmarkCapabilityEntry[] {
  return [
    {
      id: "acp-validity-canonical-projection",
      title: "Canonical ACP validity projection",
      referenceBehavior:
        "Zed keeps ACP availability and failure reasons as one canonical runtime fact set.",
      cogniaBehavior: "Manager/hook/store partially expose validity with cross-layer field drift.",
      adaptationTarget:
        "Unify manager/hook/store/router contract fields with versioned canonical projection.",
      gapGrade: "blocking",
      status: "in-progress",
      owner: "external-agent",
      evidence: [],
      updatedAt: now,
    },
    {
      id: "session-extension-operation-gating",
      title: "Session extension operation gating",
      referenceBehavior:
        "Mature ACP clients block unsupported session/list/fork/resume before optimistic dispatch.",
      cogniaBehavior: "Partial gating exists but not fully normalized for all extension flows.",
      adaptationTarget:
        "Gate unsupported extension operations with deterministic reason and tests.",
      gapGrade: "major",
      status: "validated",
      owner: "external-agent",
      evidence: [
        {
          id: "manager-session-extension-gating-test",
          kind: "test",
          summary: "ExternalAgentManager session extension gating coverage",
          reference: "lib/ai/agent/external/manager.test.ts",
          recordedAt: now,
        },
      ],
      updatedAt: now,
    },
    {
      id: "routing-fallback-diagnostics-consistency",
      title: "Routing diagnostics consistency",
      referenceBehavior:
        "External/fallback/strict routing uses normalized machine-readable reason and correlation metadata.",
      cogniaBehavior: "Route diagnostics exist but reason/executable truth can diverge by branch.",
      adaptationTarget:
        "Normalize external routing diagnostics through canonical validity projection.",
      gapGrade: "major",
      status: "validated",
      owner: "external-agent",
      evidence: [
        {
          id: "chat-routing-diagnostics-test",
          kind: "test",
          summary: "Chat container external routing diagnostics regression tests",
          reference: "components/chat/core/chat-container.test.tsx",
          recordedAt: now,
        },
      ],
      updatedAt: now,
    },
    {
      id: "session-resume-fallback-policy-deviation",
      title: "Preferred session fallback policy",
      referenceBehavior: "Some clients hard-fail when resume extension is unsupported.",
      cogniaBehavior: "Cognia degrades to new session creation for continuity.",
      adaptationTarget: "Keep continuity-first fallback while documenting deviation contract.",
      gapGrade: "minor",
      status: "intentional-deviation",
      owner: "external-agent",
      evidence: [],
      deviation: {
        rationale: "Preserve chat continuity when ACP endpoints lack session/resume support.",
        tradeOff: "Session lineage can diverge from requested preferredSessionId.",
        userImpact: "Users can continue execution without hard failure; session history may split.",
        review: {
          reviewedBy: "external-agent-maintainers",
          reviewedAt: now,
          reviewLink:
            "openspec/changes/improve-existing-external-agent-support-completeness/design.md",
        },
      },
      updatedAt: now,
    },
  ]
}

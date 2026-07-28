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

/**
 * Remediation advice for a branch reason, as i18n key ids.
 *
 * These used to be English sentences returned from `lib/`, which meant the only
 * actionable text the external-agent subsystem produced could never be shown in
 * Chinese — and, in practice, was never rendered at all. Returning ids keeps the
 * advice here (where the reason codes live) while leaving the wording to
 * `i18n/messages/{en,zh-CN}/diagnostics.json` under `recoveryHint.*`.
 *
 * Callers must resolve them: `t(\`recoveryHint.${id}\`)` in the `diagnostics`
 * namespace.
 */
function resolveRecoveryHints(reasonCode: ExternalAgentBranchReasonCode): string[] {
  switch (reasonCode) {
    case "ecosystem_prerequisite_missing":
      return ["completeSetupThenRetry"]
    case "ecosystem_documented_only":
      return ["useOfficialWorkflow", "selectLocalSurface"]
    case "protocol_unsupported":
      return ["switchToAcp", "resaveConfiguration"]
    case "transport_blocked":
      return ["useDesktopRuntime"]
    case "initialization_failed":
      return ["checkCommandAndArgs", "retryAfterReconnect"]
    case "health_check_failed":
      return ["inspectHealthEndpoint", "reconnectAndRetry"]
    case "extension_unsupported":
      return ["useSupportedOperations", "createNewSession"]
    case "session_resolution_failed":
      return ["resumeWithSessionIdOrAllowNew"]
    case "permission_denied":
      return ["adjustPermissionMode"]
    case "execution_failed":
      return ["checkDiagnosticsAndRetry"]
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
  // `recoveryHints` is a list of i18n key ids — its only consumer resolves each
  // through `t(\`recoveryHint.${id}\`)`. `ecosystem.recommendedActions` is
  // English prose assembled from runtime data (a command name, a docs URL), so
  // substituting it here fell straight through that lookup and printed raw
  // English into a Chinese UI — for `ecosystem_prerequisite_missing`, the very
  // code the localized advice was written for. The two are rendered as separate
  // lines by the panel; they are not interchangeable.
  const recoveryHints = snapshot.recoveryHints ?? resolveRecoveryHints(reasonCode)

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
    {
      id: "codex-failure-error-event-parity",
      title: "Codex turn-failure error-event parity",
      referenceBehavior:
        "OpenCode/A2A adapters emit a dedicated `error` event when a turn fails so consumers branch uniformly.",
      cogniaBehavior:
        "Codex now emits an `error` event on a failed turn before the terminal `done`, matching the other adapters.",
      adaptationTarget:
        "Surface Codex turn failures through the canonical `error` event, not only `done{success:false}`.",
      gapGrade: "major",
      status: "validated",
      owner: "external-agent",
      evidence: [
        {
          id: "codex-failed-turn-error-event-test",
          kind: "test",
          summary: "Codex app-server failed turn emits a canonical error event",
          reference: "lib/ai/agent/external/codex-app-server-client.test.ts",
          recordedAt: now,
        },
      ],
      updatedAt: now,
    },
    {
      id: "codex-session-extension-deterministic-gating",
      title: "Codex session-extension deterministic gating",
      referenceBehavior:
        "Mature clients report session list/fork/resume support deterministically instead of leaving it unknown.",
      cogniaBehavior:
        "Codex adapter reports session/list|fork|resume as deterministically `unsupported` (the protocol exposes only thread/start), so gating short-circuits with a clear reason.",
      adaptationTarget:
        "Expose getSessionExtensionSupport from the Codex adapter with deterministic unsupported state.",
      gapGrade: "minor",
      status: "validated",
      owner: "external-agent",
      evidence: [
        {
          id: "codex-extension-support-test",
          kind: "test",
          summary: "Codex app-server reports deterministic unsupported session extensions",
          reference: "lib/ai/agent/external/codex-app-server-client.test.ts",
          recordedAt: now,
        },
      ],
      updatedAt: now,
    },
    {
      id: "opencode-session-extension-connection-gated",
      title: "OpenCode session-extension support is connection-gated",
      referenceBehavior:
        "Support state should reflect real readiness, not assert a capability before the server is reachable.",
      cogniaBehavior:
        "OpenCode adapter reports list/fork/resume as `supported` only while connected (a static SDK contract) and `unknown` before connect, instead of a hardcoded `supported`.",
      adaptationTarget:
        "Derive OpenCode session-extension support from the live connection plus the typed SDK contract.",
      gapGrade: "minor",
      status: "validated",
      owner: "external-agent",
      evidence: [
        {
          id: "opencode-extension-support-test",
          kind: "test",
          summary: "OpenCode reports unknown before connect and supported once connected",
          reference: "lib/ai/agent/external/opencode-client.test.ts",
          recordedAt: now,
        },
      ],
      updatedAt: now,
    },
    {
      id: "a2a-surface-reachability",
      title: "A2A surface reachable from the UI",
      referenceBehavior:
        "A registered protocol adapter should be selectable by users, not only constructable in code.",
      cogniaBehavior:
        "The A2A protocol is now selectable in the add-agent protocol dropdown (HTTP transport, endpoint-based), no longer disabled as 'coming soon'.",
      adaptationTarget:
        "Wire the registered A2A adapter into the add-agent UI so it is not dormant.",
      gapGrade: "major",
      status: "validated",
      owner: "external-agent",
      evidence: [
        {
          id: "a2a-selectable-test",
          kind: "test",
          summary: "Add-agent dropdown exposes A2A as a selectable protocol",
          reference: "components/agent/external-agent/manager.test.tsx",
          recordedAt: now,
        },
      ],
      updatedAt: now,
    },
    {
      id: "a2a-task-protocol-projection-scope",
      title: "A2A projects the task-protocol slice only",
      referenceBehavior:
        "Rich coding agents stream reasoning, tool calls, plans, and permission requests.",
      cogniaBehavior:
        "A2A projects message text, progress, error, and done. A2A is a remote task-exchange protocol with no canonical tool-call/plan/permission streaming, so those internal events are not synthesizable.",
      adaptationTarget:
        "Map the A2A Task/Message/Artifact surface to internal streaming/progress/done events.",
      gapGrade: "minor",
      status: "intentional-deviation",
      owner: "external-agent",
      evidence: [],
      deviation: {
        rationale:
          "The A2A spec models opaque remote tasks (Task/Message/Artifact), not granular tool/plan/permission streams, so those internal events have no source to project from.",
        tradeOff: "A2A turns surface less granular live detail than ACP/Codex/OpenCode turns.",
        userImpact:
          "A2A shows streamed text, progress, completion, and errors but not per-tool or plan timelines.",
        review: {
          reviewedBy: "external-agent-maintainers",
          reviewedAt: now,
          reviewLink:
            "openspec/changes/improve-existing-external-agent-support-completeness/design.md",
        },
      },
      updatedAt: now,
    },
    {
      id: "acp-usage-context-window-only",
      title: "ACP usage is context-window occupancy only",
      referenceBehavior: "Native usage reporting splits prompt vs completion tokens.",
      cogniaBehavior:
        "ACP `usage_update` carries only context-window `used`/`size`/`cost`; the adapter maps `used` to totalTokens and leaves prompt/completion at 0 because the protocol provides no split.",
      adaptationTarget: "Surface per-turn prompt/completion token usage for ACP agents.",
      gapGrade: "minor",
      status: "intentional-deviation",
      owner: "external-agent",
      evidence: [],
      deviation: {
        rationale:
          "The canonical ACP usage_update notification reports context-window occupancy (used/size) and cumulative cost, not a prompt/completion breakdown.",
        tradeOff:
          "Per-turn ACP token accounting reports a total rather than an input/output split.",
        userImpact:
          "Usage panels show total context tokens for ACP agents instead of separate prompt/completion counts.",
        review: {
          reviewedBy: "external-agent-maintainers",
          reviewedAt: now,
          reviewLink:
            "openspec/changes/improve-existing-external-agent-support-completeness/design.md",
        },
      },
      updatedAt: now,
    },
    {
      id: "codex-agent-auth-env-based",
      title: "Codex agent auth is environment-based",
      referenceBehavior:
        "Some clients drive interactive account login/logout through the protocol.",
      cogniaBehavior:
        "Codex auth flows through CODEX_ACCESS_TOKEN (ChatGPT) or OPENAI_API_KEY/CODEX_API_KEY env injection — matching the codex-cli contract and the ACP path — rather than the protocol's account/login methods.",
      adaptationTarget: "Authenticate Codex through the protocol account/login surface.",
      gapGrade: "minor",
      status: "intentional-deviation",
      owner: "external-agent",
      evidence: [],
      deviation: {
        rationale:
          "Codex CLI's real contract is env-based credentials; reusing them keeps auth consistent with the ACP shim and the rest of the subsystem.",
        tradeOff:
          "The adapter cannot surface an unauthenticated/expired state at the protocol level; failures appear as turn errors.",
        userImpact:
          "Auth issues show up when a turn fails rather than as a distinct pre-flight auth prompt.",
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

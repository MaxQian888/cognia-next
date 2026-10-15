import type { ChangesetState } from "@/lib/scm/types"

export const REVIEW_REASON_KEYS: Readonly<Record<string, string>> = {
  "protectedPath:ci": "reasons.protectedCi",
  "protectedPath:hooks": "reasons.protectedHooks",
  "protectedPath:deploy": "reasons.protectedDeploy",
  "protectedPath:migrations": "reasons.protectedMigrations",
  "protectedPath:ownership": "reasons.protectedOwnership",
  "protectedPath:cogniaConfig": "reasons.protectedCogniaConfig",
  "protectedPath:repositoryPolicy": "reasons.protectedRepositoryPolicy",
  dependencyChange: "reasons.dependencyChange",
  largeChange: "reasons.largeChange",
  massDeletion: "reasons.massDeletion",
  binaryChange: "reasons.binaryChange",
  sensitiveWithheld: "reasons.sensitiveWithheld",
  humanApprovalAlways: "reasons.humanApprovalAlways",
  "reviewAgentUnavailable:noModel": "reasons.noModel",
  "reviewAgentUnavailable:unparseable": "reasons.unparseable",
  "reviewAgentUnavailable:failed": "reasons.agentFailed",
  "reviewAgentUnavailable:incomplete": "reasons.incomplete",
  reviewAgentRedacted: "reasons.reviewAgentRedacted",
}

export function reviewReasonKey(code: string): string {
  if (code === "reviewPolicyInvalid" || code.startsWith("reviewPolicyInvalid:"))
    return "reasons.reviewPolicyInvalid"
  return Object.hasOwn(REVIEW_REASON_KEYS, code) ? REVIEW_REASON_KEYS[code] : "reasons.unknown"
}

export const INTEGRATION_REASON_KEYS: Readonly<Record<string, string>> = Object.fromEntries(
  [
    "target_moved",
    "target_checked_out_dirty",
    "stale_candidate",
    "stale_head",
    "ineligible",
    "checks",
    "busy",
    "cycles",
    "dependency",
    "rollback_conflict",
    "attempts_exhausted",
    "invalid_state",
    "changeset_state",
    "conflict",
    "nothing_to_capture",
    "not_found",
    "invalid_request",
    "checks_unmet",
    "aborted",
    "host_error",
  ].map((code) => [code, `integrationReasons.${code}`])
)

export function integrationReasonKey(code: string): string {
  return Object.hasOwn(INTEGRATION_REASON_KEYS, code)
    ? INTEGRATION_REASON_KEYS[code]
    : "integrationReasons.unknown"
}

export function changesetActions(state: ChangesetState) {
  const editable = state === "ready" || state === "approved" || state === "changesRequested"
  return {
    review: state === "draft" || editable,
    approve: editable,
    requestChanges: editable,
    select: state === "approved" || state === "queued",
    abandon: !["integrating", "merged", "rolledBack", "abandoned"].includes(state),
  }
}

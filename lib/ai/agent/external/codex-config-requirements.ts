/**
 * Codex's enterprise/managed configuration limits (`configRequirements/read`),
 * and the check that keeps Cognia from asking for something they forbid.
 *
 * A managed Codex — one deployed with an admin config stack — can restrict which
 * sandbox modes, approval policies and permission profiles a client may select.
 * Cognia has always sent its own `sandbox` / `approvalPolicy` regardless.
 *
 * The check has to be PROACTIVE, and that is not a preference. The 0.150.1
 * schema has no typed refusal: `CodexErrorInfo` offers `badRequest`,
 * `sandboxError` and `unauthorized`, none of which means "your admin forbids
 * this", and `JSONRPCErrorError` is `{code, message, data?}`. A rejected request
 * is therefore indistinguishable from any other bad request once it comes back,
 * so the only place the reason still exists is before it is sent. Writing a
 * matcher against a guessed payload would be worse than none: it would sit there
 * never firing while looking like coverage.
 *
 * Everything here is fail-OPEN on absence and fail-CLOSED on presence:
 * requirements we could not read constrain nothing (a Codex with no managed
 * config must behave exactly as before), but a limit we DID read is honoured
 * even when it is empty.
 */

import type { ExternalAgentBranchReasonCode } from "@/types/agent/external-agent"

import type { CodexSandboxModeWire } from "@/lib/ai/agent/external/codex-app-server-client"

/** The subset of `ConfigRequirements` that bears on what Cognia sends. */
export interface CodexConfigRequirements {
  /** `SandboxMode` values this Codex may be asked for. */
  allowedSandboxModes?: CodexSandboxModeWire[]
  /** `AskForApproval` string variants this Codex may be asked for. */
  allowedApprovalPolicies?: string[]
  /**
   * Permission-profile ids, as an object MAP `{[id]: boolean}` — not an array.
   * A profile mapped to `false` is present but forbidden.
   */
  allowedPermissionProfiles?: Record<string, boolean>
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value.filter((entry): entry is string => typeof entry === "string")
}

function booleanMap(value: unknown): Record<string, boolean> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const out: Record<string, boolean> = {}
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw === "boolean") out[key] = raw
  }
  return out
}

/**
 * Read a `configRequirements/read` payload.
 *
 * Returns `null` for anything unreadable. A malformed payload must not become a
 * half-populated requirements object: a missing axis reads as "unconstrained",
 * so inventing one would silently relax a limit an admin actually set, and
 * inventing an empty one would block a Codex that never restricted anything.
 */
export function mapCodexConfigRequirements(raw: unknown): CodexConfigRequirements | null {
  if (!raw || typeof raw !== "object") return null
  const source = (raw as { requirements?: unknown }).requirements ?? raw
  if (!source || typeof source !== "object") return null
  const record = source as Record<string, unknown>

  const mapped: CodexConfigRequirements = {}
  const sandboxModes = stringArray(record.allowedSandboxModes)
  if (sandboxModes) mapped.allowedSandboxModes = sandboxModes as CodexSandboxModeWire[]
  const approvalPolicies = stringArray(record.allowedApprovalPolicies)
  if (approvalPolicies) mapped.allowedApprovalPolicies = approvalPolicies
  const profiles = booleanMap(record.allowedPermissionProfiles)
  if (profiles) mapped.allowedPermissionProfiles = profiles

  return Object.keys(mapped).length > 0 ? mapped : null
}

/** Which axis of a request a managed policy refused. */
export type CodexRequirementAxis = "sandbox" | "approvalPolicy" | "permissionProfile"

export interface CodexRequirementRefusal {
  axis: CodexRequirementAxis
  requested: string
  /** What the managed config does permit, for a message the user can act on. */
  allowed: string[]
}

/** A request Cognia declined to send because the local Codex's admin config forbids it. */
export class CodexManagedPolicyError extends Error {
  readonly code = "managed_policy_refused" as const
  /**
   * The branch reason this refusal classifies as.
   *
   * The field name matters: `canonical-contract.ts` and the ACP client read
   * `reasonCode` off a thrown error to pick an `ExternalAgentBranchReasonCode`,
   * so declaring only `code` left `managed_policy_refused` a variant nothing
   * could ever produce — the error surfaced as a generic execution failure
   * carrying an English sentence built inside `lib/`.
   */
  readonly reasonCode: ExternalAgentBranchReasonCode = "managed_policy_refused"
  readonly refusals: CodexRequirementRefusal[]

  constructor(refusals: CodexRequirementRefusal[]) {
    super(
      `Codex managed configuration refuses this request: ${refusals
        .map((r) => `${r.axis}="${r.requested}" (allowed: ${r.allowed.join(", ") || "none"})`)
        .join("; ")}`
    )
    this.name = "CodexManagedPolicyError"
    this.refusals = refusals
  }
}

export function isCodexManagedPolicyError(error: unknown): error is CodexManagedPolicyError {
  return error instanceof CodexManagedPolicyError
}

/**
 * Every axis of `request` the managed configuration forbids. Empty means send it.
 *
 * `undefined` requirements, or an unconstrained axis, refuse nothing. A request
 * value that is itself absent refuses nothing either — Cognia omits a parameter
 * precisely so Codex applies its own default, and its own default is by
 * definition allowed.
 */
export function checkCodexRequestAgainstRequirements(
  request: {
    sandbox?: string
    approvalPolicy?: string
    permissionProfile?: string
  },
  requirements: CodexConfigRequirements | null | undefined
): CodexRequirementRefusal[] {
  if (!requirements) return []
  const refusals: CodexRequirementRefusal[] = []

  if (request.sandbox !== undefined && requirements.allowedSandboxModes) {
    if (!requirements.allowedSandboxModes.includes(request.sandbox as CodexSandboxModeWire)) {
      refusals.push({
        axis: "sandbox",
        requested: request.sandbox,
        allowed: [...requirements.allowedSandboxModes],
      })
    }
  }

  if (request.approvalPolicy !== undefined && requirements.allowedApprovalPolicies) {
    if (!requirements.allowedApprovalPolicies.includes(request.approvalPolicy)) {
      refusals.push({
        axis: "approvalPolicy",
        requested: request.approvalPolicy,
        allowed: [...requirements.allowedApprovalPolicies],
      })
    }
  }

  if (request.permissionProfile !== undefined && requirements.allowedPermissionProfiles) {
    const map = requirements.allowedPermissionProfiles
    if (map[request.permissionProfile] !== true) {
      refusals.push({
        axis: "permissionProfile",
        requested: request.permissionProfile,
        allowed: Object.entries(map)
          .filter(([, allowed]) => allowed)
          .map(([id]) => id),
      })
    }
  }

  return refusals
}

/** Throw {@link CodexManagedPolicyError} when the managed config forbids the request. */
export function assertCodexRequestAllowed(
  request: { sandbox?: string; approvalPolicy?: string; permissionProfile?: string },
  requirements: CodexConfigRequirements | null | undefined
): void {
  const refusals = checkCodexRequestAgainstRequirements(request, requirements)
  if (refusals.length > 0) throw new CodexManagedPolicyError(refusals)
}

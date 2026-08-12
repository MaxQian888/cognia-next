// Cross-host dispatch preflight (ADR-0090 Phase 7, reusing ADR-0082 rules).
//
// A delegation that leaves the current host must fail BEFORE dispatch — not
// on the remote side — when any of these cannot be proven:
//   1. the HandoffEnvelope survives serialization and carries only stable
//      refs (no machine-local absolute paths, no secret/URL shapes);
//   2. the target host serves every hard capability the child's frozen spec
//      requires;
//   3. the child's credential reference is resolvable ON the target host
//      (credential locality — secrets never ride the envelope);
//   4. the single-writer run lease was claimed BEFORE dispatch.
// On success the target host is pinned into the child policy so the resolver
// freezes `hostRef` — side-effectful work never migrates silently.
//
// AgentTeam remote dispatch calls this gate after claiming the child lease and
// before session/create. Device identity and authorization are established by
// the Companion worker front door; only stable refs reach this boundary.

import type { AgentCapabilityId } from "@cognia/agent-config-types/agent-execution"
import { validateHandoffEnvelope, type HandoffEnvelope } from "@cognia/agent/handoff-envelope"

export class CrossHostPreflightError extends Error {
  readonly code:
    | "envelope-not-serializable"
    | "envelope-invalid"
    | "capability-missing"
    | "credential-not-local"
    | "lease-not-held"
  readonly detail: string[]

  constructor(code: CrossHostPreflightError["code"], detail: string[]) {
    super(`cross-host dispatch preflight failed (${code}): ${detail.join("; ")}`)
    this.name = "CrossHostPreflightError"
    this.code = code
    this.detail = detail
  }
}

export interface CrossHostTarget {
  hostRef: string
  /** Capabilities the target host's runtime serves (from its certification/status). */
  capabilities: readonly AgentCapabilityId[]
  /** Credential profile refs resolvable ON the target host. */
  localCredentialProfileRefs: readonly string[]
}

export interface CrossHostPreflightInput {
  envelope: HandoffEnvelope
  target: CrossHostTarget
  /** Hard capabilities the child's frozen spec requires. */
  requiredCapabilities: readonly AgentCapabilityId[]
  /** Whether the dispatching side holds the child run's single-writer lease. */
  leaseHeld: boolean
}

export interface CrossHostPreflightResult {
  /** The envelope with the target host pinned into its execution binding. */
  envelope: HandoffEnvelope
  /** Host pin the caller must feed into the child's resolver policy. */
  hostPin: { mode: "pinned"; hostRef: string }
}

/**
 * Run every preflight check; throws a typed {@link CrossHostPreflightError}
 * on the FIRST failing gate (ordered cheapest → most stateful). Returns the
 * host-pinned envelope on success.
 */
export function preflightCrossHostDispatch(
  input: CrossHostPreflightInput
): CrossHostPreflightResult {
  // 1a. Structural validity (refs only, no secrets/URLs/absolute paths).
  const violations = validateHandoffEnvelope(input.envelope)
  if (violations.length > 0) {
    throw new CrossHostPreflightError("envelope-invalid", violations)
  }

  // 1b. Serialization round-trip — what the remote host receives must equal
  // what we validated (no cycles, no functions, no lossy values).
  let roundTripped: HandoffEnvelope
  try {
    roundTripped = JSON.parse(JSON.stringify(input.envelope)) as HandoffEnvelope
  } catch (err) {
    throw new CrossHostPreflightError("envelope-not-serializable", [
      err instanceof Error ? err.message : String(err),
    ])
  }
  if (JSON.stringify(roundTripped) !== JSON.stringify(input.envelope)) {
    throw new CrossHostPreflightError("envelope-not-serializable", [
      "envelope does not survive a JSON round-trip",
    ])
  }

  // 2. Target capability coverage for the child's hard requirements.
  const served = new Set(input.target.capabilities)
  const missing = input.requiredCapabilities.filter((cap) => !served.has(cap))
  if (missing.length > 0) {
    throw new CrossHostPreflightError("capability-missing", missing)
  }

  // 3. Credential locality: the ref must resolve ON the target host.
  const credentialRef = input.envelope.execution.credentialProfileRef
  if (credentialRef && !input.target.localCredentialProfileRefs.includes(credentialRef)) {
    throw new CrossHostPreflightError("credential-not-local", [credentialRef])
  }

  // 4. Lease before dispatch — single writer, always.
  if (!input.leaseHeld) {
    throw new CrossHostPreflightError("lease-not-held", [input.envelope.identity.childRunId])
  }

  return {
    envelope: {
      ...roundTripped,
      execution: { ...roundTripped.execution, hostRef: input.target.hostRef },
    },
    hostPin: { mode: "pinned", hostRef: input.target.hostRef },
  }
}

// HandoffEnvelope (ADR-0090 Phase 7).
//
// The ONLY thing a parent and a delegated child exchange. Everything in it is
// an id, an enum, or a stable REFERENCE — never key material, never a
// credential-bearing URL, never a host-local absolute path. The validator
// enforces that structurally so a leaking envelope is a type error at the
// boundary, not a code-review hope.
//
// Zero-dependency hand-written guards, matching the rest of this package.

import type { AgentRuntimeAdapterId } from "./agent-execution"
import { absolutePathViolation, isNonEmptyString, refViolation } from "./ref-safety"

/** Delegation execution binding carried on the envelope — refs only. */
export interface HandoffExecutionBinding {
  /** How the resolver classified this delegation (delegation-mode.ts). */
  mode: "native" | "orchestrated"
  /** Fingerprint of the CHILD's frozen spec (identity for audit/remint). */
  executionFingerprint?: string
  runtimeAdapter?: AgentRuntimeAdapterId
  /** Deployment profile id (P1 store) — an id, never a base URL. */
  deploymentRef?: string
  /** Credential PROFILE reference — never key material. */
  credentialProfileRef?: string
  /** Host pin for cross-host dispatch (ADR-0082 host id). */
  hostRef?: string
  /** Which frozen model role the child runs as (native mode's only variance). */
  modelRole?: "primary" | "fast" | "powerful"
}

/** Stable resource reference — logical refs, never machine-local paths. */
export interface HandoffResourceRef {
  /** e.g. "workspace" | "worktree" | "artifact" | "dataset". */
  kind: string
  /** Stable logical ref (workspace key, artifact id, remote URI by POLICY id). */
  ref: string
}

export interface HandoffEnvelope {
  envelopeVersion: 1
  identity: {
    parentRunId: string
    childRunId: string
    teamId?: string
    taskId?: string
    /** Delegation depth of the CHILD (root children are depth 1). */
    depth: number
    /** Run-id chain from the root parent down to (excluding) the child. */
    parentChain: string[]
  }
  task: {
    title?: string
    prompt: string
    expectedOutput?: string
  }
  execution: HandoffExecutionBinding
  /** Budget slice the root governor allocated to this child. */
  budget?: {
    maxTokens?: number
  }
  resources?: HandoffResourceRef[]
  /** ISO timestamp minted by the dispatching side. */
  createdAt: string
}

// ---- Validation --------------------------------------------------------------

/**
 * Validate an envelope. Returns a list of violations (empty = valid). Ref
 * positions (`deploymentRef`, `credentialProfileRef`, `hostRef`, resource
 * refs) additionally reject secret- and URL-shaped values; resource refs also
 * reject machine-local absolute paths (cross-host safety).
 */
export function validateHandoffEnvelope(value: unknown): string[] {
  const errors: string[] = []
  if (!value || typeof value !== "object") return ["envelope must be an object"]
  const env = value as Partial<HandoffEnvelope>

  if (env.envelopeVersion !== 1) errors.push("envelopeVersion must be 1")

  const id = env.identity
  if (!id || typeof id !== "object") {
    errors.push("identity is required")
  } else {
    if (!isNonEmptyString(id.parentRunId)) errors.push("identity.parentRunId is required")
    if (!isNonEmptyString(id.childRunId)) errors.push("identity.childRunId is required")
    if (typeof id.depth !== "number" || id.depth < 1 || !Number.isInteger(id.depth)) {
      errors.push("identity.depth must be an integer >= 1")
    }
    if (!Array.isArray(id.parentChain) || id.parentChain.some((p) => !isNonEmptyString(p))) {
      errors.push("identity.parentChain must be a string array")
    }
  }

  if (!env.task || !isNonEmptyString(env.task.prompt)) {
    errors.push("task.prompt is required")
  }

  const exec = env.execution
  if (!exec || typeof exec !== "object") {
    errors.push("execution is required")
  } else {
    if (exec.mode !== "native" && exec.mode !== "orchestrated") {
      errors.push('execution.mode must be "native" or "orchestrated"')
    }
    for (const [field, ref] of [
      ["deploymentRef", exec.deploymentRef],
      ["credentialProfileRef", exec.credentialProfileRef],
      ["hostRef", exec.hostRef],
    ] as const) {
      if (ref === undefined) continue
      if (!isNonEmptyString(ref)) {
        errors.push(`execution.${field} must be a non-empty string`)
        continue
      }
      const violation = refViolation(ref)
      if (violation) errors.push(`execution.${field}: ${violation}`)
    }
  }

  for (const [i, res] of (env.resources ?? []).entries()) {
    if (!res || !isNonEmptyString(res.kind) || !isNonEmptyString(res.ref)) {
      errors.push(`resources[${i}] must have kind and ref`)
      continue
    }
    const violation = refViolation(res.ref)
    if (violation) errors.push(`resources[${i}].ref: ${violation}`)
    // Machine-local absolute paths do not survive a host boundary.
    const pathViolation = absolutePathViolation(res.ref)
    if (pathViolation) errors.push(`resources[${i}].ref: ${pathViolation}`)
  }

  if (!isNonEmptyString(env.createdAt) || Number.isNaN(Date.parse(env.createdAt))) {
    errors.push("createdAt must be an ISO timestamp")
  }

  return errors
}

export function isHandoffEnvelope(value: unknown): value is HandoffEnvelope {
  return validateHandoffEnvelope(value).length === 0
}

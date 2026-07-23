// Compatibility manifests (ADR-0090 Phase 5).
//
// A manifest is the SIGNED output of one full conformance-suite run against
// one exact execution path. It is the ONLY artifact `auto` may accept as
// evidence (plan §3.3): connectivity probes and experimental opt-ins are
// different types on purpose — they cannot be converted into a manifest.
//
// Storage authority is the bundle directory (desktop + headless share the
// layout); Dexie only ever holds a rebuildable projection.

import type { AgentCapabilityId } from "./agent-execution"
import { isAgentCapabilityId } from "./agent-execution"

export type CompatibilityEvidenceLevel =
  "native" | "vendor-certified" | "cognia-verified" | "experimental" | "unsupported"

export type CapabilitySupport = "supported" | "unsupported" | "unknown"

/**
 * The orthogonal identity of one certified execution path. Every axis
 * participates in staleness: a change to ANY of them invalidates the record
 * for `auto` until re-certified.
 */
export interface CompatibilityRecordKey {
  runtime: string
  ingressProtocol: string
  /** "gateway" | "direct". */
  routeMode: string
  /** "passthrough" | "translated". Cross-protocol paths must certify the translation. */
  translationMode: string
  deploymentRef: string
  model: string
  agentSdkVersion: string
  claudeCodeVersion: string
  gatewayVersion: string
  suiteVersion: string
}

export interface SuiteCaseResult {
  caseId: string
  passed: boolean
  detail?: string
}

export interface CompatibilityManifest {
  manifestVersion: 1
  bundleId: string
  key: CompatibilityRecordKey
  evidence: CompatibilityEvidenceLevel
  /** core | extended | full (plan §3.3 capability levels). */
  level: "core" | "extended" | "full"
  capabilities: Partial<Record<AgentCapabilityId, CapabilitySupport>>
  suiteResults: SuiteCaseResult[]
  /** Same-protocol gateway/direct parity verdict for this path. */
  parity: { passed: boolean; detail?: string }
  /** Known, accepted semantic losses on this path (may be empty). */
  knownLosses: string[]
  issuer: "cognia-ci" | "vendor" | "local"
  issuedAt: string
  expiresAt?: string
  /** Base64 Ed25519 signature over the canonical payload (sans signature). */
  signature?: string
}

export type ManifestValidation =
  { ok: true; value: CompatibilityManifest } | { ok: false; errors: string[] }

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

const EVIDENCE_LEVELS: readonly string[] = [
  "native",
  "vendor-certified",
  "cognia-verified",
  "experimental",
  "unsupported",
]

const KEY_FIELDS: ReadonlyArray<keyof CompatibilityRecordKey> = [
  "runtime",
  "ingressProtocol",
  "routeMode",
  "translationMode",
  "deploymentRef",
  "model",
  "agentSdkVersion",
  "claudeCodeVersion",
  "gatewayVersion",
  "suiteVersion",
]

export function validateCompatibilityManifest(v: unknown): ManifestValidation {
  const errors: string[] = []
  if (!isRecord(v)) return { ok: false, errors: ["manifest must be an object"] }

  if (v.manifestVersion !== 1) errors.push("manifestVersion must be 1")
  if (typeof v.bundleId !== "string" || v.bundleId.length === 0) {
    errors.push("bundleId must be a non-empty string")
  }

  const key = v.key
  if (!isRecord(key)) {
    errors.push("key must be an object")
  } else {
    for (const field of KEY_FIELDS) {
      if (typeof key[field] !== "string" || key[field] === "") {
        errors.push(`key.${field} must be a non-empty string`)
      }
    }
  }

  if (!EVIDENCE_LEVELS.includes(v.evidence as string)) {
    errors.push("evidence must be a known evidence level")
  }
  if (!["core", "extended", "full"].includes(v.level as string)) {
    errors.push("level must be core|extended|full")
  }

  if (!isRecord(v.capabilities)) {
    errors.push("capabilities must be an object")
  } else {
    for (const [capability, support] of Object.entries(v.capabilities)) {
      if (!isAgentCapabilityId(capability)) {
        errors.push(`capabilities: unknown capability id "${capability}"`)
      }
      if (!["supported", "unsupported", "unknown"].includes(support as string)) {
        errors.push(`capabilities.${capability} must be supported|unsupported|unknown`)
      }
    }
  }

  if (!Array.isArray(v.suiteResults)) {
    errors.push("suiteResults must be an array")
  } else {
    v.suiteResults.forEach((result, index) => {
      if (
        !isRecord(result) ||
        typeof result.caseId !== "string" ||
        typeof result.passed !== "boolean"
      ) {
        errors.push(`suiteResults[${index}] must carry caseId + passed`)
      }
    })
  }

  if (!isRecord(v.parity) || typeof v.parity.passed !== "boolean") {
    errors.push("parity.passed must be a boolean")
  }
  if (!Array.isArray(v.knownLosses) || v.knownLosses.some((l) => typeof l !== "string")) {
    errors.push("knownLosses must be a string array")
  }
  if (!["cognia-ci", "vendor", "local"].includes(v.issuer as string)) {
    errors.push("issuer must be cognia-ci|vendor|local")
  }
  if (typeof v.issuedAt !== "string" || v.issuedAt.length === 0) {
    errors.push("issuedAt must be an ISO timestamp string")
  }
  if (v.expiresAt !== undefined && typeof v.expiresAt !== "string") {
    errors.push("expiresAt must be a string when present")
  }
  if (v.signature !== undefined && typeof v.signature !== "string") {
    errors.push("signature must be a string when present")
  }

  return errors.length > 0
    ? { ok: false, errors }
    : { ok: true, value: v as unknown as CompatibilityManifest }
}

/**
 * Canonical signing payload: sorted-key JSON of the manifest WITHOUT the
 * signature field. Both the signer (emit-manifest) and every verifier use
 * this exact encoding.
 */
export function manifestSigningPayload(manifest: CompatibilityManifest): string {
  const { signature: _signature, ...rest } = manifest
  const canonicalize = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonicalize)
    if (typeof value === "object" && value !== null) {
      const source = value as Record<string, unknown>
      const out: Record<string, unknown> = {}
      for (const key of Object.keys(source).sort()) {
        if (source[key] === undefined) continue
        out[key] = canonicalize(source[key])
      }
      return out
    }
    return value
  }
  return JSON.stringify(canonicalize(rest))
}

/** Stable string form of a record key (map/index key). */
export function compatibilityKeyId(key: CompatibilityRecordKey): string {
  return KEY_FIELDS.map((field) => key[field]).join("|")
}

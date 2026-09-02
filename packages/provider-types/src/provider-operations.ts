/**
 * Provider operation contract (ADR-0163).
 *
 * One machine-readable descriptor per operation a provider can be asked to
 * perform, and the vocabulary for saying, per provider × operation, what the
 * host can actually do about it. The descriptors themselves live in
 * `protocol/provider-operations.json`. This module owns the TYPES and the
 * frozen id list, so the package stays free of app-tree imports.
 *
 * Vocabulary reuse, on purpose:
 * - `operation` / `risk` / `idempotency` are the companion command vocabulary
 *   (`lib/tauri/command-descriptors.ts`), so one set of words governs both
 *   the RPC plane and the provider plane.
 * - `remoteExposure` is the companion `CommandTarget` vocabulary minus
 *   `service`, so `authorize_transport` semantics carry over unchanged.
 * - Typed failures are {@link ProviderDiagnosticFailure}: no parallel union.
 *   "The provider cannot" versus "the host has not wired it" is carried by
 *   {@link ProviderOperationSupport} (`unsupported` versus `unknown`), which
 *   is where that distinction belongs.
 */

import type { ProviderDiagnosticFailure } from "./provider-diagnostics"
import type {
  ProviderModelCandidate,
  ProviderModelFreshness,
  ProviderModelSource,
} from "./model-discovery-types"

/** Every operation id, in manifest order. The JSON must match exactly. */
export const PROVIDER_OPERATION_IDS = [
  "models.list",
  "models.get",
  "capabilities.read",
  "auth.status",
  "health.probe",
  "language.generate",
  "language.stream",
  "language.tools",
  "language.structured-output",
  "tokens.count",
  "moderation.create",
  "embeddings.create",
  "rerank.create",
  "images.generate",
  "images.edit",
  "videos.generate",
  "videos.get",
  "videos.cancel",
  "videos.content",
  "speech.generate",
  "transcription.create",
  "translation.create",
  "realtime.connect",
  "files.upload",
  "files.list",
  "files.get",
  "files.content",
  "files.delete",
  "vector-stores.create",
  "vector-stores.list",
  "vector-stores.get",
  "vector-stores.delete",
  "vector-stores.files.add",
  "vector-stores.files.remove",
  "batches.create",
  "batches.list",
  "batches.get",
  "batches.cancel",
  "batches.results",
  "fine-tuning.jobs.create",
  "fine-tuning.jobs.list",
  "fine-tuning.jobs.get",
  "fine-tuning.jobs.cancel",
  "fine-tuning.events.list",
  "fine-tuning.checkpoints.list",
  "balance.read",
  "quota.read",
  "rate-limits.read",
  "usage.provider.read",
  "usage.local.read",
] as const

export type ProviderOperationId = (typeof PROVIDER_OPERATION_IDS)[number]

/** `^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$`: dotted, at least two segments. */
export const PROVIDER_OPERATION_ID_PATTERN = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/

export function isProviderOperationId(value: string): value is ProviderOperationId {
  return (PROVIDER_OPERATION_IDS as readonly string[]).includes(value)
}

export const PROVIDER_OPERATION_GROUPS = [
  "discovery",
  "language",
  "retrieval",
  "media",
  "files-jobs",
  "account",
] as const
export type ProviderOperationGroup = (typeof PROVIDER_OPERATION_GROUPS)[number]

/** Six scopes, not fifty capabilities. */
export const PROVIDER_OPERATION_SCOPES = [
  "provider:read",
  "provider:invoke",
  "provider:write",
  "provider:files",
  "provider:jobs",
  "account:read",
] as const
export type ProviderOperationScope = (typeof PROVIDER_OPERATION_SCOPES)[number]

/** Where the I/O can physically execute. */
export const PROVIDER_OPERATION_SURFACES = ["renderer", "sidecar", "rust-proxy"] as const
export type ProviderOperationSurface = (typeof PROVIDER_OPERATION_SURFACES)[number]

export const PROVIDER_OPERATION_REMOTE_EXPOSURES = ["client", "execution", "host-admin"] as const
export type ProviderOperationRemoteExposure = (typeof PROVIDER_OPERATION_REMOTE_EXPOSURES)[number]

export const PROVIDER_OPERATION_KINDS = ["read", "write", "side-effect"] as const
export type ProviderOperationKind = (typeof PROVIDER_OPERATION_KINDS)[number]

export const PROVIDER_OPERATION_RISKS = ["low", "high", "critical"] as const
export type ProviderOperationRisk = (typeof PROVIDER_OPERATION_RISKS)[number]

export const PROVIDER_OPERATION_IDEMPOTENCIES = ["structural", "required", "forbidden"] as const
export type ProviderOperationIdempotency = (typeof PROVIDER_OPERATION_IDEMPOTENCIES)[number]

export const PROVIDER_OPERATION_BILLINGS = ["free", "metered", "metered-unknown"] as const
export type ProviderOperationBilling = (typeof PROVIDER_OPERATION_BILLINGS)[number]

export const PROVIDER_OPERATION_PII_GATES = ["outbound-text", "none"] as const
export type ProviderOperationPiiGate = (typeof PROVIDER_OPERATION_PII_GATES)[number]

export const PROVIDER_OPERATION_STREAMINGS = ["never", "optional", "always"] as const
export type ProviderOperationStreaming = (typeof PROVIDER_OPERATION_STREAMINGS)[number]

export const PROVIDER_OPERATION_STATEFUL_HANDLES = ["none", "provider-pinned"] as const
export type ProviderOperationStatefulHandle = (typeof PROVIDER_OPERATION_STATEFUL_HANDLES)[number]

export interface ProviderOperationDescriptor {
  id: ProviderOperationId
  group: ProviderOperationGroup
  operation: ProviderOperationKind
  risk: ProviderOperationRisk
  idempotency: ProviderOperationIdempotency
  /** Cost ceiling gate evaluated before execution. */
  billing: ProviderOperationBilling
  scopes: ProviderOperationScope[]
  /** At least one. Encodes the packaged-CSP trap as a declared property. */
  surfaces: ProviderOperationSurface[]
  remoteExposure: ProviderOperationRemoteExposure
  /** `outbound-text` ⇒ the executor runs the PII gate once, centrally. */
  piiGate: ProviderOperationPiiGate
  streaming: ProviderOperationStreaming
  /** `provider-pinned` operations never fail over across providers or pools. */
  statefulHandle: ProviderOperationStatefulHandle
  /** Named zod export in `provider-operation-schemas.ts`, not a `$ref`. */
  inputSchema: string
  outputSchema: string
}

export interface ProviderOperationManifest {
  schemaVersion: 1
  operations: ProviderOperationDescriptor[]
}

/**
 * How a provider × operation cell is served.
 * - `native`: the provider exposes the operation on its own API.
 * - `translated`: served through a protocol translation the host owns.
 * - `derived`: computed from other operations or catalog data (no call).
 * - `plugin`: an installed plugin adapter serves it (`via` names it).
 * - `unsupported`: the provider cannot do this. Terminal and honest. Needs
 *   a `reason`, has no handler.
 * - `unknown`: only for custom / plugin deployments or a transient probe
 *   failure. Must say where it came from and when to retry. Never a valid
 *   static answer for a built-in provider.
 */
export type ProviderOperationSupport =
  "native" | "translated" | "derived" | "plugin" | "unsupported" | "unknown"

export type ProviderOperationAvailability =
  "ready" | "needs-auth" | "needs-config" | "needs-host" | "unavailable"

export type ProviderOperationUnknownProvenance = "custom-deployment" | "plugin" | "probe-failed"

export interface ProviderOperationRetryCondition {
  on: "auth-change" | "config-change" | "manual" | "timer"
  afterMs?: number
}

interface ProviderOperationCellBase {
  operationId: ProviderOperationId
  availability: ProviderOperationAvailability
  /** Human-readable note for the availability (missing key, host, …). */
  note?: string
}

export interface ProviderOperationServedCell extends ProviderOperationCellBase {
  support: "native" | "translated" | "derived"
}

export interface ProviderOperationPluginCell extends ProviderOperationCellBase {
  support: "plugin"
  /** `<pluginId>:<adapterId>`. */
  via: string
}

export interface ProviderOperationUnsupportedCell extends ProviderOperationCellBase {
  support: "unsupported"
  availability: "unavailable"
  reason: string
}

export interface ProviderOperationUnknownCell extends ProviderOperationCellBase {
  support: "unknown"
  provenance: ProviderOperationUnknownProvenance
  freshness: ProviderModelFreshness
  failure: ProviderDiagnosticFailure
  retry: ProviderOperationRetryCondition
}

export type ProviderOperationCell =
  | ProviderOperationServedCell
  | ProviderOperationPluginCell
  | ProviderOperationUnsupportedCell
  | ProviderOperationUnknownCell

export interface ProviderOperationProfile {
  providerId: string
  /** Deployment the cells were computed for. Absent for the built-in default. */
  deploymentRef?: string
  computedAt: number
  cells: ProviderOperationCell[]
}

/**
 * Model entitlement for one deployment × account. Keyed by both because a
 * key rotation or organisation switch changes what is listed.
 */
export interface ProviderModelInventory {
  providerId: string
  deploymentRef: string
  accountRef?: string
  models: ProviderModelCandidate[]
  source: ProviderModelSource
  freshness: ProviderModelFreshness
  fetchedAt: number
  expiresAt?: number
}

export interface ProviderAccountSnapshot {
  providerId: string
  deploymentRef: string
  accountRef: string
  capturedAt: number
  balance?: { amount: number; currency: string; kind: "prepaid" | "postpaid" | "credits" }
  quota?: { used: number; limit?: number; unit: string; resetsAt?: number }
  rateLimits?: Array<{ name: string; remaining?: number; limit?: number; resetsAt?: number }>
}

export type ProviderResourceHandleKind =
  "file" | "vector-store" | "batch" | "fine-tuning-job" | "video" | "realtime-session"

/**
 * A provider-side resource id together with WHO owns it. Files, batches,
 * vector stores and jobs live inside one deployment × account × credential.
 * Later operations pin to all four and never fail over.
 */
export interface ProviderResourceHandle {
  kind: ProviderResourceHandleKind
  id: string
  providerId: string
  deploymentRef: string
  accountRef: string
  /** Fingerprint of the credential the resource was created with. */
  credentialAffinity: string
  createdAt?: number
}

export interface ProviderOperationRequest<TInput = unknown> {
  operationId: ProviderOperationId
  /** Explicit provider. Absent ⇒ feature resolution picks one. */
  providerId?: string
  deploymentRef?: string
  /** Scopes the caller holds. The executor refuses missing ones. */
  scopes: ProviderOperationScope[]
  /** Surface the caller is executing on. */
  surface: ProviderOperationSurface
  input: TInput
  /** Required for `provider-pinned` operations that address a resource. */
  handle?: ProviderResourceHandle
  requestId?: string
}

export interface ProviderOperationSuccess<TOutput = unknown> {
  ok: true
  operationId: ProviderOperationId
  providerId: string
  deploymentRef?: string
  support: Exclude<ProviderOperationSupport, "unsupported" | "unknown">
  via?: string
  output: TOutput
  /** Metered usage when the provider reports it. */
  usage?: { inputTokens?: number; outputTokens?: number; units?: Record<string, number> }
}

export interface ProviderOperationFailure {
  ok: false
  operationId: ProviderOperationId
  providerId?: string
  deploymentRef?: string
  availability: ProviderOperationAvailability
  failure: ProviderDiagnosticFailure
  attemptedProviderIds?: string[]
}

export type ProviderOperationResult<TOutput = unknown> =
  ProviderOperationSuccess<TOutput> | ProviderOperationFailure

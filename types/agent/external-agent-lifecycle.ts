/**
 * Canonical external-Agent lifecycle contracts (ADR-0090 lifecycle plane).
 *
 * One serializable vocabulary for the whole lifecycle: what a runtime IS
 * (catalog), how Cognia may obtain it (distribution), what a saved Agent is
 * bound to (binding), what is actually on this host (receipt), whether the
 * version may run (assessment), what an update would change (candidate), where
 * secrets live (credential refs), and what a Windows user explicitly consented
 * to (consent).
 *
 * Deliberately free of behavior beyond guards and normalizers: desktop, CLI/TUI
 * and the gate all read these shapes, and only the lifecycle service mutates
 * them. Capability profiles remain the authority on what an Agent can DO —
 * receipts and version assessments describe what may LAUNCH, and must never
 * become a second capability authority.
 *
 * @see docs/content/docs/en/adr/0090-unified-agent-execution-and-gateway-compatibility.md
 */

import type { ExternalAgentProtocol, ExternalAgentTransport } from "./external-agent"

// ============================================================================
// Failure codes
// ============================================================================

/**
 * Stable, non-localized lifecycle failure codes.
 *
 * Every lifecycle refusal picks one. UI strings are keyed on the code, so a new
 * code is a user-visible contract change and needs i18n entries in both
 * catalogues.
 */
export const EXTERNAL_AGENT_LIFECYCLE_ERROR_CODES = [
  /** No runtime is installed or discoverable for this binding. */
  "runtime_missing",
  /** The detected version is outside the catalog's supported range. */
  "version_unsupported",
  /** Supported but not certified — runnable only after explicit consent. */
  "version_uncertified",
  /** A digest, checksum or signature did not match the catalog. */
  "integrity_failed",
  /** A required secret has no resolvable keyring entry. */
  "credential_missing",
  /** No protocol adapter is registered (usually a disabled plugin). */
  "adapter_unavailable",
  /** Live sessions or processes still use the target. */
  "active_sessions",
  /** Another saved configuration still references this runtime. */
  "runtime_referenced",
  /** A Windows unsandboxed launch needs per-Agent consent that is absent. */
  "consent_required",
  /** This platform cannot host the runtime at all. */
  "platform_unsupported",
] as const

export type ExternalAgentLifecycleErrorCode = (typeof EXTERNAL_AGENT_LIFECYCLE_ERROR_CODES)[number]

export function isExternalAgentLifecycleErrorCode(
  value: unknown
): value is ExternalAgentLifecycleErrorCode {
  return (
    typeof value === "string" &&
    (EXTERNAL_AGENT_LIFECYCLE_ERROR_CODES as readonly string[]).includes(value)
  )
}

/**
 * A lifecycle refusal carrying a stable code plus non-secret detail.
 *
 * `details` is logged and rendered, so callers must never place a resolved
 * secret in it — pass the credential *slot* name instead of its value.
 */
export class ExternalAgentLifecycleError extends Error {
  readonly code: ExternalAgentLifecycleErrorCode
  readonly details?: Readonly<Record<string, string | number | boolean>>

  constructor(
    code: ExternalAgentLifecycleErrorCode,
    message: string,
    details?: Readonly<Record<string, string | number | boolean>>
  ) {
    super(message)
    this.name = "ExternalAgentLifecycleError"
    this.code = code
    this.details = details
  }
}

export function isExternalAgentLifecycleError(
  value: unknown
): value is ExternalAgentLifecycleError {
  return value instanceof ExternalAgentLifecycleError
}

// ============================================================================
// Ownership and providers
// ============================================================================

/**
 * Who owns the bytes that get launched.
 *
 * `managed` — Cognia installed it into a verified root it may also remove.
 * `system`  — the user installed it; Cognia discovers, certifies and launches
 *             it but never deletes it.
 * `remote`  — nothing local to install; the Agent is reached over the network.
 */
export type ExternalAgentRuntimeOwnership = "managed" | "system" | "remote"

/** Distribution providers a managed installation may use. */
export const EXTERNAL_AGENT_RUNTIME_PROVIDERS = ["npm", "pnpm", "bun", "uvx", "binary"] as const

export type ExternalAgentRuntimeProvider = (typeof EXTERNAL_AGENT_RUNTIME_PROVIDERS)[number]

/** The JavaScript providers, which share the frozen-lock install contract. */
export const EXTERNAL_AGENT_JS_PROVIDERS = ["npm", "pnpm", "bun"] as const

export type ExternalAgentJsProvider = (typeof EXTERNAL_AGENT_JS_PROVIDERS)[number]

export function isJsRuntimeProvider(
  provider: ExternalAgentRuntimeProvider
): provider is ExternalAgentJsProvider {
  return (EXTERNAL_AGENT_JS_PROVIDERS as readonly string[]).includes(provider)
}

/**
 * The frozen-install command each JavaScript provider must use.
 *
 * A managed install never resolves a range at install time, which is the whole
 * reason the lock asset is mandatory.
 */
export const JS_PROVIDER_FROZEN_INSTALL: Readonly<
  Record<ExternalAgentJsProvider, { command: string; args: readonly string[]; lockfile: string }>
> = {
  npm: { command: "npm", args: ["ci"], lockfile: "package-lock.json" },
  pnpm: { command: "pnpm", args: ["install", "--frozen-lockfile"], lockfile: "pnpm-lock.yaml" },
  bun: { command: "bun", args: ["install", "--frozen-lockfile"], lockfile: "bun.lock" },
}

/**
 * A checked-in lock asset approved for one (runtime, version, provider) triple.
 *
 * `path` is repo-relative and `sha256` pins its bytes, so a lock cannot be
 * swapped for one that resolves different packages. Without an approved asset
 * the provider is simply not offered — it is never silently downgraded to an
 * unpinned install.
 */
export interface ExternalAgentLockAsset {
  /** Repo-relative path to the frozen lockfile. */
  path: string
  /** Lowercase hex SHA-256 of the lockfile bytes. */
  sha256: string
}

/** Integrity metadata for a downloaded artifact. */
export interface ExternalAgentArtifactIntegrity {
  /** Lowercase hex SHA-256 of the artifact bytes. */
  sha256: string
  /** Optional detached signature URL (https only). */
  signatureUrl?: string
  /** Key id the signature must verify against. */
  signingKeyId?: string
}

/** A managed distribution served by a JavaScript package manager. */
export interface ExternalAgentJsDistribution {
  provider: ExternalAgentJsProvider
  /** Registry package name. */
  packageName: string
  /** Exact version — never a range, never `latest`. */
  version: string
  /** Executable path relative to the managed install root. */
  entrypoint: string
  /** Arguments appended after the entrypoint at launch. */
  args?: string[]
  /** Approved frozen lock for this exact (package, version, provider). */
  lockAsset: ExternalAgentLockAsset
  /** Registry integrity string (`sha512-…`) when the registry publishes one. */
  registryIntegrity?: string
}

/** A managed distribution served by uv / uvx. */
export interface ExternalAgentUvxDistribution {
  provider: "uvx"
  /** PyPI distribution name. */
  packageName: string
  /** Exact version — never a range. */
  version: string
  /** Console-script name uv installs. */
  entrypoint: string
  args?: string[]
  /** Approved `uv.lock` for this exact (package, version). */
  lockAsset: ExternalAgentLockAsset
}

/** One platform's artifact in a verified binary distribution. */
export interface ExternalAgentBinaryArtifact {
  /** `<os>-<arch>`, e.g. `darwin-arm64`. */
  platformKey: string
  /** https URL of the artifact. */
  url: string
  integrity: ExternalAgentArtifactIntegrity
  /** How the artifact is packed; `none` is a bare executable. */
  archive: "none" | "tar.gz" | "zip"
  /** Executable path inside the archive, relative to the install root. */
  entrypoint: string
}

/** A managed distribution served as a verified binary artifact. */
export interface ExternalAgentBinaryDistribution {
  provider: "binary"
  /** Exact release version the artifacts belong to. */
  version: string
  artifacts: ExternalAgentBinaryArtifact[]
  args?: string[]
}

export type ExternalAgentDistribution =
  ExternalAgentJsDistribution | ExternalAgentUvxDistribution | ExternalAgentBinaryDistribution

export function isJsDistribution(
  distribution: ExternalAgentDistribution
): distribution is ExternalAgentJsDistribution {
  return isJsRuntimeProvider(distribution.provider as ExternalAgentRuntimeProvider)
}

export function isBinaryDistribution(
  distribution: ExternalAgentDistribution
): distribution is ExternalAgentBinaryDistribution {
  return distribution.provider === "binary"
}

// ============================================================================
// Catalog
// ============================================================================

/** How a runtime reports its version, and how to read the answer. */
export interface ExternalAgentVersionProbe {
  /** Arguments appended to the launch command, e.g. `["--version"]`. */
  args: string[]
  /**
   * Named parser applied to the probe's stdout. Named rather than inlined as a
   * regex so the same rule is available to Rust and the gate without shipping
   * an executable pattern in JSON.
   */
  parser: ExternalAgentVersionParserId
  /** Hard bound on the probe; an unbounded probe hangs the connect path. */
  timeoutMs: number
}

/**
 * Version-output shapes Cognia knows how to read.
 *
 * `semver-anywhere` finds the first `x.y.z` in the output and covers almost
 * every CLI. The others exist because a runtime prints something a loose scan
 * would misread (a build number, a bundled-package version).
 */
export const EXTERNAL_AGENT_VERSION_PARSERS = [
  "semver-anywhere",
  "semver-first-line",
  "semver-prefixed-v",
  "json-version-field",
] as const

export type ExternalAgentVersionParserId = (typeof EXTERNAL_AGENT_VERSION_PARSERS)[number]

/** A trusted channel that publishes newer certified versions. */
export interface ExternalAgentUpdateChannel {
  /** https URL of the signed channel document. */
  url: string
  /** Key id the channel document's signature must verify against. */
  signingKeyId?: string
}

/** Sandbox policy for one runtime. */
export interface ExternalAgentSandboxPolicy {
  /**
   * Whether Cognia requires its sandbox. macOS and Linux are always `true`;
   * this exists so a catalog entry can be inspected without knowing the host.
   */
  required: boolean
  /**
   * Whether a Windows desktop user may consent to running this runtime
   * unsandboxed. Never implies consent — only that consent is offerable.
   */
  windowsExceptionEligible: boolean
}

/** A plugin that must be installed for this runtime's adapter to exist. */
export interface ExternalAgentRuntimePluginRequirement {
  pluginId: string
  /** Semver range the plugin must satisfy. */
  versionRange: string
}

/**
 * The canonical description of one launchable external-Agent runtime.
 *
 * Replaces the command-only install hints on presets: a preset says what to
 * configure, a catalog entry says what may be installed, certified and run.
 */
export interface ExternalAgentRuntimeCatalogEntry {
  /** Stable id, independent of preset naming. */
  runtimeId: string
  /** Preset ids this runtime backs. May be empty for discovery-only runtimes. */
  presetIds: string[]
  displayName: string
  ownership: ExternalAgentRuntimeOwnership
  protocol: ExternalAgentProtocol
  transport: ExternalAgentTransport
  /** Plugin that must supply the protocol adapter, when it is not built in. */
  plugin?: ExternalAgentRuntimePluginRequirement
  /** Node-style platform ids this runtime supports, e.g. `darwin`. */
  platforms: string[]
  /**
   * Launch command for `system` runtimes: the bare binary name resolved on
   * PATH. Managed runtimes launch their distribution entrypoint instead, and
   * remote runtimes launch nothing.
   */
  systemCommand?: string
  /** Arguments the launch always carries. */
  launchArgs?: string[]
  /** How to read the installed version. Absent for `remote` runtimes. */
  versionProbe?: ExternalAgentVersionProbe
  /** Semver range that may run at all. */
  supportedRange?: string
  /** Exact versions that run without extra consent. */
  certifiedVersions?: string[]
  updateChannel?: ExternalAgentUpdateChannel
  /**
   * Managed distributions, most-preferred first. Empty means the runtime is not
   * Cognia-installable yet and the user manages it themselves; it is never a
   * licence to fall back to an unpinned install.
   */
  distributions: ExternalAgentDistribution[]
  sandbox: ExternalAgentSandboxPolicy
  /** Docs URL used by the user-managed install handoff. */
  docsUrl?: string
}

/** The whole catalog as it is persisted in `protocol/external-agent-runtimes.json`. */
export interface ExternalAgentRuntimeCatalog {
  version: number
  runtimes: ExternalAgentRuntimeCatalogEntry[]
}

// ============================================================================
// Binding, receipt, status
// ============================================================================

/**
 * What a saved Agent configuration is bound to.
 *
 * Replaces the registry-only `registryProvenance` field: that recorded where a
 * config came from, this records what it runs and can be re-verified.
 */
export interface ExternalAgentRuntimeBinding {
  runtimeId: string
  ownership: ExternalAgentRuntimeOwnership
  /** Provider of the managed install actually in use. */
  provider?: ExternalAgentRuntimeProvider
  /** Receipt id for a managed install; absent for `system` / `remote`. */
  receiptId?: string
  /** Canonical absolute executable path resolved for a `system` runtime. */
  resolvedExecutablePath?: string
  /** Version this binding was last certified against. */
  pinnedVersion?: string
}

/** Result of the post-install / pre-activation health check. */
export interface ExternalAgentRuntimeHealth {
  healthy: boolean
  checkedAt: string
  /** Non-localized findings; UI strings are keyed on `code`. */
  findings: { code: string; severity: "error" | "warning"; detail: string }[]
}

/**
 * Host-local proof of one managed installation.
 *
 * Desktop and CLI/TUI share this schema and the catalog, but never a directory
 * or any mutable state: each host installs, certifies and removes its own copy.
 */
export interface ExternalAgentRuntimeReceipt {
  /** Stable id for this installation, referenced by bindings. */
  receiptId: string
  runtimeId: string
  version: string
  provider: ExternalAgentRuntimeProvider
  /** Version of the provider tool itself, e.g. the npm that ran `npm ci`. */
  providerVersion: string
  /** Where the bytes came from: registry package spec or artifact URL. */
  source: string
  /** Absolute managed root Cognia owns and may remove. */
  installRoot: string
  /** Absolute path to the launched entrypoint inside `installRoot`. */
  entrypoint: string
  integrity?: ExternalAgentArtifactIntegrity
  /** SHA-256 of the lock asset that produced this tree. */
  lockDigest?: string
  /** SHA-256 over the installed tree, recomputed to detect tampering. */
  treeDigest: string
  installedAt: string
  activatedAt?: string
  health: ExternalAgentRuntimeHealth
  /**
   * The previous healthy installation, kept as the single rollback slot. It is
   * retained until a later update succeeds or the user removes it explicitly.
   */
  previous?: ExternalAgentRuntimeRollbackSlot
}

/** The one retained rollback slot. */
export interface ExternalAgentRuntimeRollbackSlot {
  receiptId: string
  version: string
  installRoot: string
  entrypoint: string
  treeDigest: string
  activatedAt?: string
}

/** Aggregate runtime state for one catalog entry on this host. */
export interface ExternalAgentRuntimeStatus {
  runtimeId: string
  ownership: ExternalAgentRuntimeOwnership
  /** Receipt of the active managed install, when there is one. */
  receipt?: ExternalAgentRuntimeReceipt
  /** Version verdict for whatever is currently installed/discovered. */
  assessment: ExternalAgentVersionAssessment
  /** Agent config ids that still reference this runtime. */
  referencedBy: string[]
  /** Live sessions across every referencing Agent. */
  activeSessionCount: number
  /** Whether an update check found a newer certified candidate. */
  updateAvailable?: ExternalAgentUpdateCandidate
}

// ============================================================================
// Version assessment
// ============================================================================

/**
 * What the catalog says about the version actually present.
 *
 * `certified` runs normally, `supported-uncertified` runs only after consent
 * tied to executable identity + version, and everything else fails closed with
 * install/update guidance rather than launching and hoping.
 */
export type ExternalAgentVersionVerdict =
  "certified" | "supported-uncertified" | "unsupported" | "unparseable" | "missing"

export interface ExternalAgentVersionAssessment {
  runtimeId: string
  verdict: ExternalAgentVersionVerdict
  /** Parsed semver, when the probe produced one. */
  detectedVersion?: string
  /** Raw probe output, truncated. Kept for the "unparseable" case. */
  rawOutput?: string
  /** Absolute executable the probe ran, for `system` runtimes. */
  executablePath?: string
  /** Identity of that executable, so consent can be invalidated when it moves. */
  executableDigest?: string
  supportedRange?: string
  checkedAt: string
  /** Lifecycle code a caller should raise when this verdict blocks a launch. */
  blockingCode?: ExternalAgentLifecycleErrorCode
}

/** A newer version an update channel offers. */
export interface ExternalAgentUpdateCandidate {
  runtimeId: string
  /** Version currently installed/discovered. */
  fromVersion?: string
  /** Version the channel offers. */
  toVersion: string
  provider: ExternalAgentRuntimeProvider
  source: string
  integrity?: ExternalAgentArtifactIntegrity
  /** Whether the candidate is in the catalog's certified list. */
  certified: boolean
  /** Whether an approved lock exists for this (version, provider). */
  installable: boolean
  /** Why it is not installable, when it is not. */
  blockingCode?: ExternalAgentLifecycleErrorCode
  discoveredAt: string
}

// ============================================================================
// Credentials
// ============================================================================

/**
 * Logical secret slots an external Agent can require.
 *
 * Named slots rather than free-form keys so redaction, export sanitization and
 * the "which secret is missing" message all agree on one vocabulary.
 */
export const EXTERNAL_AGENT_CREDENTIAL_SLOTS = [
  "apiKey",
  "bearerToken",
  "headers",
  "proxyAuth",
  "processEnv",
] as const

export type ExternalAgentCredentialSlot = (typeof EXTERNAL_AGENT_CREDENTIAL_SLOTS)[number]

/**
 * Keyring references stored on a config in place of the secrets themselves.
 *
 * Values are opaque keyring key ids under the external-Agent namespace, never
 * the secret. Resolution happens immediately before a connect or spawn.
 */
export type ExternalAgentCredentialRefs = Partial<Record<ExternalAgentCredentialSlot, string>>

/** Marker written into a sanitized export where a secret used to be. */
export const EXTERNAL_AGENT_CREDENTIAL_REQUIRED_MARKER = "__cognia_credential_required__"

// ============================================================================
// Windows unsandboxed consent
// ============================================================================

/**
 * One Windows desktop user's explicit consent to run one Agent unsandboxed.
 *
 * Every field is part of the binding: if the executable, its version, the
 * launch command, the security policy revision or the runtime provider change,
 * the consent no longer describes what would run and must be re-collected.
 * CLI/TUI never reads this — it stays fail-closed on Windows.
 */
export interface UnsandboxedLaunchConsent {
  agentId: string
  runtimeId: string
  /** Absolute path of the executable consented to. */
  executablePath: string
  /** SHA-256 of that executable, so a replaced binary invalidates consent. */
  executableDigest: string
  runtimeVersion: string
  /** SHA-256 over the canonicalized command + args actually launched. */
  commandDigest: string
  /** `EXTERNAL_AGENT_SECURITY_POLICY_VERSION` at confirmation time. */
  policyRevision: number
  /** Stable host identifier; consent never travels between machines. */
  hostId: string
  confirmedAt: string
  /** Provider of the managed install consented to, when managed. */
  provider?: ExternalAgentRuntimeProvider
}

/** The identity a consent record is checked against at launch time. */
export interface UnsandboxedLaunchIdentity {
  agentId: string
  runtimeId: string
  executablePath: string
  executableDigest: string
  runtimeVersion: string
  commandDigest: string
  policyRevision: number
  hostId: string
  provider?: ExternalAgentRuntimeProvider
}

/** Why a stored consent no longer applies. */
export type UnsandboxedConsentInvalidationReason =
  | "agent-mismatch"
  | "runtime-mismatch"
  | "executable-path-changed"
  | "executable-changed"
  | "version-changed"
  | "command-changed"
  | "policy-revised"
  | "host-changed"
  | "provider-changed"

/**
 * Check a stored consent against what is about to launch.
 *
 * Returns every reason it fails rather than the first, so the disclosure can
 * tell the user what changed instead of only that something did.
 */
export function assessUnsandboxedConsent(
  consent: UnsandboxedLaunchConsent | null | undefined,
  identity: UnsandboxedLaunchIdentity
): { valid: boolean; reasons: UnsandboxedConsentInvalidationReason[] } {
  if (!consent) return { valid: false, reasons: [] }

  const reasons: UnsandboxedConsentInvalidationReason[] = []
  if (consent.agentId !== identity.agentId) reasons.push("agent-mismatch")
  if (consent.runtimeId !== identity.runtimeId) reasons.push("runtime-mismatch")
  if (consent.executablePath !== identity.executablePath) reasons.push("executable-path-changed")
  if (consent.executableDigest !== identity.executableDigest) reasons.push("executable-changed")
  if (consent.runtimeVersion !== identity.runtimeVersion) reasons.push("version-changed")
  if (consent.commandDigest !== identity.commandDigest) reasons.push("command-changed")
  if (consent.policyRevision !== identity.policyRevision) reasons.push("policy-revised")
  if (consent.hostId !== identity.hostId) reasons.push("host-changed")
  if ((consent.provider ?? null) !== (identity.provider ?? null)) reasons.push("provider-changed")

  return { valid: reasons.length === 0, reasons }
}

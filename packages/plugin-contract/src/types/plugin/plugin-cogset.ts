/**
 * Cogsets, cogpacks and install origins (ADR-0209).
 *
 * - A **cogset** is a named, local set of plugins that should run together,
 *   with each member's non-secret config. At most one is active on a host, and
 *   switching is exclusive except for the host's always-on set.
 * - A **cogpack** is the shareable file: a signed, versioned zip naming a set
 *   of plugins, each pinned to an exact revision, referenced when it can be
 *   fetched again and embedded when it cannot.
 * - An **install origin** records where an installed plugin came from, pinned
 *   to what was actually installed. It is what lets a cogset be exported.
 *
 * Pure types and constants only; behavior lives in `lib/plugin/{origin,cogset,cogpack}/`.
 */

// =============================================================================
// Install origins
// =============================================================================

/** An origin the importer can fetch again, byte for byte or commit for commit. */
export type ReproducibleInstallOrigin =
  /** Ships with the app: a browser built-in or an installer-bundled plugin. */
  | { kind: "builtin" }
  /** A public GitHub repository at an exact commit. */
  | { kind: "github"; owner: string; repo: string; subdir?: string; commit: string }
  /** Any git remote at an exact commit (prebuilt WASM repositories). */
  | { kind: "git"; url: string; commit: string }
  /** The HTTP plugin registry at an exact version. */
  | { kind: "registry"; registryUrl: string; version: string; checksum?: string }
  /** A signed WASM bundle at a URL, pinned by the bundle's hash. */
  | {
      kind: "url"
      bundleUrl: string
      sha256: string
      signatureUrl?: string
      /** Base64 Ed25519 key the bundle is expected to be signed with. */
      publicKey?: string
    }
  /** An Open VSX extension at an exact version, pinned by the VSIX hash. */
  | {
      kind: "openvsx"
      namespace: string
      name: string
      version: string
      sha256: string
      targetPlatform?: string
    }

/** How a plugin with no re-fetchable origin reached this host. */
export const LOCAL_INSTALL_VIAS = [
  "directory",
  "manifest-import",
  "wasm-file",
  "vsix",
  "disk",
  "restored",
  "cogpack-embedded",
  /** Installed from a source string that could not be pinned to a revision. */
  "unpinned",
] as const
export type LocalInstallVia = (typeof LOCAL_INSTALL_VIAS)[number]

export type PluginInstallOrigin =
  ReproducibleInstallOrigin | { kind: "local"; via: LocalInstallVia }

export type PluginInstallOriginKind = PluginInstallOrigin["kind"]

/** The cogpack a plugin was installed through, when it was. */
export interface CogpackProvenance {
  cogpackId: string
  version: string
  /** sha256 of the cogpack file. */
  fingerprint: string
}

/** One row per installed plugin, keyed by plugin id. */
export interface PluginInstallOriginRecord {
  pluginId: string
  /** The plugin's manifest version when this origin was recorded. */
  version: string
  origin: PluginInstallOrigin
  viaCogpack?: CogpackProvenance
  recordedAt: number
}

// =============================================================================
// Cogsets
// =============================================================================

export interface CogsetMember {
  pluginId: string
  /**
   * The version this cogset expects. Absent means any installed version. A
   * mismatch is reported on activation, never silently accepted.
   */
  expectedVersion?: string
  /**
   * Non-secret config applied before the plugin is enabled. Absent means the
   * cogset leaves the plugin's config alone.
   */
  config?: Record<string, unknown>
  /** An optional member that is missing does not make the cogset partial. */
  optional?: boolean
}

/** Why one plugin did not reach the state a cogset asked for. */
export const COGSET_OUTCOME_REASONS = [
  "not-installed",
  "version-mismatch",
  /** A required dependency is not installed. */
  "dependency-missing",
  /** A required dependency is installed but cannot run here. */
  "dependency-disabled",
  /** The installed dependency does not satisfy the required version range. */
  "dependency-version",
  /** The plugin is part of a required-dependency cycle. */
  "dependency-cycle",
  "blocked",
  "enable-failed",
  "disable-failed",
  "config-failed",
] as const
export type CogsetOutcomeReason = (typeof COGSET_OUTCOME_REASONS)[number]

export interface CogsetPluginOutcome {
  pluginId: string
  action: "enable" | "disable" | "config" | "keep"
  ok: boolean
  reason?: CogsetOutcomeReason
  /**
   * Detail the plugin manager reported for a failed enable, disable or config
   * step. Every reason the plan decides carries structured fields instead.
   */
  message?: string
  /** For `version-mismatch`: what the cogset expects and what is installed. */
  expectedVersion?: string
  installedVersion?: string
  /** For the `dependency-*` reasons: the dependency this plugin cannot get. */
  dependencyId?: string
  /** For `dependency-missing` / `dependency-version`: the range it requires. */
  dependencyConstraint?: string
  /** For `dependency-version`: the version that is installed instead. */
  dependencyFound?: string
  /** For `dependency-cycle`: the plugin ids in the cycle, in order. */
  cycle?: string[]
  /** An optional member's problem does not make the cogset partial. */
  optional?: boolean
}

export interface CogsetAppliedState {
  status: "applied" | "partial"
  at: number
  outcomes: CogsetPluginOutcome[]
}

export type CogsetSource =
  | { kind: "default" }
  | { kind: "manual" }
  | { kind: "preset"; presetId: string; presetName: string }
  | {
      kind: "cogpack"
      cogpackId: string
      version: string
      fingerprint: string
      /** The `cogpackInstalls` row that created this cogset. */
      installId: string
    }

export interface CogsetRow {
  id: string
  name: string
  description?: string
  members: CogsetMember[]
  source: CogsetSource
  /** The last activation's per-plugin result. */
  lastApplied?: CogsetAppliedState
  createdAt: number
  updatedAt: number
}

/** The cogset switch waits for this before disabling plugins under a live run. */
export type CogsetPendingReason = "runs-in-flight"

/** The host's cogset state. A singleton keyed by {@link COGSET_STATE_ID}. */
export interface CogsetStateRow {
  id: typeof COGSET_STATE_ID
  /** The cogset the user last chose globally. */
  globalCogsetId?: string
  /** Plugins enabled under every cogset. Local to this host; never exported. */
  alwaysOn: string[]
  /** The cogset whose reconciliation last ran on this host. */
  appliedCogsetId?: string
  appliedAt?: number
  /** An automatic switch waiting for in-flight runs to settle. */
  pending?: { cogsetId: string; reason: CogsetPendingReason; since: number }
  /** Set once the Default cogset has been created from the enabled plugins. */
  defaultBootstrappedAt?: number
  updatedAt: number
}

export const COGSET_STATE_ID = "host" as const

/** Why the effective cogset is the one it is. */
export type EffectiveCogsetSource = "session" | "workspace" | "global"

// =============================================================================
// Cogpacks
// =============================================================================

export const COGPACK_SCHEMA_VERSION = 1 as const
export const COGPACK_KIND = "cognia.cogpack" as const
export const COGPACK_FILE_EXTENSION = ".cogpack"
export const COGPACK_MIME_TYPE = "application/vnd.cognia.cogpack+zip"

export interface CogpackFileRecord {
  /** Package-relative path, under `plugins/<id>/`. */
  path: string
  sha256: string
  size?: number
}

/** Where the importer gets a member from. */
export type CogpackMemberSource =
  | ReproducibleInstallOrigin
  | {
      kind: "embedded"
      /** Package directory holding the plugin tree, `plugins/<id>`. */
      root: string
      files: CogpackFileRecord[]
    }

export interface CogpackMember {
  id: string
  name: string
  version: string
  /** The importer may skip it without the cogset counting as incomplete. */
  optional: boolean
  source: CogpackMemberSource
  /** Non-secret config. Never contains a `secret: true` field. */
  config?: Record<string, unknown>
  /** Names of `secret: true` config fields the importer must fill in. */
  secretFields?: string[]
}

export interface CogpackSignature {
  algorithm: "ed25519"
  publisher: string
  /** Base64 raw 32-byte Ed25519 public key. */
  publicKey: string
  /** Base64 raw 64-byte signature over the canonical manifest without `signature`. */
  signature: string
}

export interface CogpackManifestV1 {
  schemaVersion: typeof COGPACK_SCHEMA_VERSION
  kind: typeof COGPACK_KIND
  id: string
  version: string
  name: string
  description?: string
  compatibility: {
    /** The app version that exported it; built-in members need at least this. */
    minHostVersion: string
  }
  members: CogpackMember[]
  signature?: CogpackSignature
}

/** How much the importer can trust who made a cogpack. */
export type CogpackTrust = "trusted" | "signed-unknown" | "unsigned"

/** One imported cogpack, keyed by an install id. */
export interface CogpackInstallRow {
  id: string
  cogpackId: string
  version: string
  name: string
  fingerprint: string
  trust: CogpackTrust
  signerPublicKey?: string
  signerName?: string
  /** The manifest as imported, kept for update diffs. */
  manifest: CogpackManifestV1
  /** The cogset the import created. */
  cogsetId: string
  /** Members that were not installed, with the reason. */
  missing: Array<{ pluginId: string; reason: string }>
  installedAt: number
}

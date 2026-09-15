/**
 * The EnvironmentSpec wire type (ADR-0182).
 *
 * Mirrors `crates/cognia-environment/src/spec.rs` field for field. The brain
 * resolves one of these per sandbox acquisition
 * (`lib/project-environment/resolve-environment-spec.ts`); the Rust side
 * re-validates it at admission and recomputes its digest. The digest is
 * SHA-256 over the RFC 8785 canonical JSON of the spec without `specDigest`
 * and `explain`, so both sides produce the same hex string —
 * `protocol/environment-spec-fixtures.json` pins that.
 *
 * Optional fields are OMITTED, never `undefined`-valued-but-present and never
 * `null`: a `null` changes the canonical bytes and therefore the digest.
 */

/** Weakest first; the index order is the strength order. */
export const ISOLATION_TIERS = ["container", "gvisor", "vm"] as const
export type IsolationTier = (typeof ISOLATION_TIERS)[number]

/** The stricter of two tiers. */
export function strongerIsolationTier(a: IsolationTier, b: IsolationTier): IsolationTier {
  return ISOLATION_TIERS.indexOf(a) >= ISOLATION_TIERS.indexOf(b) ? a : b
}

/** Whether `tier` is at least as strong as `floor`. */
export function isolationTierMeets(tier: IsolationTier, floor: IsolationTier): boolean {
  return ISOLATION_TIERS.indexOf(tier) >= ISOLATION_TIERS.indexOf(floor)
}

/** One sandbox per workspace (suspended when idle), or one per run. */
export type SandboxLifecycleKind = "persistent" | "ephemeral"

/** Egress posture. "Open" travels as `on`, the value `ProjectEnvironmentPolicy.network` persists. */
export type EgressTier = "off" | "allowlist" | "on"

export type DeclarationFile = "workspace-json" | "devcontainer"

/** Where a spec came from, in precedence order. */
export type EnvironmentSource =
  | { kind: "project-setting"; catalogEntryId: string }
  | {
      kind: "repo-declaration"
      file: DeclarationFile
      /** Repository-relative path of the declaring file. */
      path: string
      remote: string
      /** Full SHA-1 or SHA-256 object id the declaration was read at. */
      commitSha: string
      /** See `lib/project-environment/environment-declaration.ts`. */
      declarationDigest: string
      /** A server-side approval id on a shared Host, `device:<key>` on a desktop. */
      approvalRef: string
    }
  | { kind: "deployment-default"; catalogEntryId: string }

export interface PinnedImage {
  registry: string
  repository: string
  /** `sha256:<64 lowercase hex>`. */
  digest: string
}

export interface SpecImage extends PinnedImage {
  catalogEntryId?: string
  /** Content-hash key of the environment build that produced the image (ADR-0186). */
  buildKey?: string
}

export interface SpecBundle {
  /** `sha256:` digest of the agent bundle image (ADR-0183). */
  digest: string
  releaseTag: string
  /** True when the project pinned this bundle rather than following the release. */
  pinned: boolean
}

export interface IsolationRequirement {
  minimum: IsolationTier
}

export type DeclaredUserSource = "remoteUser" | "containerUser" | "image"

export interface DeclaredUser {
  name?: string
  uid?: number
  from: DeclaredUserSource
}

export interface SpecUser {
  /** Absent when neither the declaration nor the image names a user (ADR-0183 tier default). */
  declared?: DeclaredUser
}

export type SingleCommandSpec =
  /** Run through `/bin/sh -c`. */
  | { kind: "shell"; command: string }
  /** Exec directly, no shell. */
  | { kind: "argv"; argv: string[] }

/** One lifecycle command. `parallel` runs named commands concurrently and cannot nest. */
export type CommandSpec =
  SingleCommandSpec | { kind: "parallel"; commands: Record<string, SingleCommandSpec> }

export interface LifecycleCommands {
  /** First create. */
  onCreate?: CommandSpec
  /** First create, after `onCreate`. */
  updateContent?: CommandSpec
  /** First create, after `updateContent`. */
  postCreate?: CommandSpec
  /** Every start and resume. */
  postStart?: CommandSpec
  /** Every session attach. */
  postAttach?: CommandSpec
}

export const LIFECYCLE_COMMAND_NAMES = [
  "onCreate",
  "updateContent",
  "postCreate",
  "postStart",
  "postAttach",
] as const satisfies ReadonlyArray<keyof LifecycleCommands>

export interface ForwardPort {
  port: number
  label?: string
}

export interface EgressSpec {
  tier: EgressTier
  /** Baseline egress preset ids. */
  presetIds: string[]
  /** Project-declared domains that passed approval. */
  approvedDomains: string[]
}

/** One step of how a spec was resolved. Codes, not prose: the UI localizes them. */
export interface EnvironmentResolutionStep {
  layer:
    | "project-setting"
    | "repo-declaration"
    | "deployment-default"
    | "size-class"
    | "bundle"
    | "isolation"
    | "user"
    | "egress"
  outcome: "chosen" | "skipped"
  code: string
  detail?: Record<string, string | number | boolean>
}

export interface EnvironmentSpecExplain {
  steps: EnvironmentResolutionStep[]
}

/** The resolved, immutable description of one sandbox's environment. */
export interface EnvironmentSpec {
  version: 1
  /** Lowercase hex SHA-256; see the module header. */
  specDigest: string
  projectId: string
  source: EnvironmentSource
  image: SpecImage
  bundle: SpecBundle
  isolation: IsolationRequirement
  sizeClassId: string
  lifecycle: SandboxLifecycleKind
  user: SpecUser
  /**
   * Values may contain `${containerEnv:NAME}` / `${containerEnv:NAME:default}`,
   * which `cognia-sandboxd` expands against the image's environment when a
   * process starts. No other `${…}` form survives resolution.
   */
  containerEnv: Record<string, string>
  lifecycleCommands: LifecycleCommands
  forwardPorts: ForwardPort[]
  egress: EgressSpec
  browserSidecar: boolean
  /** ADR-0147 digest of the workspace.json whose setup/actions run inside the sandbox. */
  workspaceConfigDigest?: string
  /** Resolution trace. Excluded from the digest. */
  explain?: EnvironmentSpecExplain
}

/** Limits shared with `spec.rs` (`limits`). */
export const ENVIRONMENT_SPEC_LIMITS = {
  maxIdLength: 256,
  maxEnvEntries: 256,
  maxEnvValueBytes: 32 * 1024,
  maxShellCommandBytes: 64 * 1024,
  maxArgvEntries: 256,
  maxArgvEntryBytes: 32 * 1024,
  maxParallelCommands: 16,
  maxForwardPorts: 64,
  maxPortLabelLength: 128,
  maxEgressDomains: 256,
  maxEgressPresets: 64,
  /** Environment variables with this prefix belong to the supervisor. */
  reservedEnvPrefix: "COGNIA_",
} as const

/** Where the workspace is mounted inside every sandbox (ADR-0183). */
export const SANDBOX_WORKSPACE_FOLDER = "/workspace"

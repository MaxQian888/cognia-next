import type { IsolationTier, SandboxLifecycleKind } from "./sandbox/environment-spec"

/** Host OS variants supported by project-local setup scripts and actions. */
export type ProjectEnvironmentOs = "macos" | "windows" | "linux"

export interface ProjectEnvironmentScript {
  /** Portable fallback used when no OS-specific override exists. */
  default: string
  /** Optional overrides for commands that differ by host OS. */
  byOs?: Partial<Record<ProjectEnvironmentOs, string>>
}

export interface ProjectEnvironmentAction {
  id: string
  name: string
  icon?: string
  script: ProjectEnvironmentScript
}

export interface ProjectEnvironmentKeyringReference {
  /** Environment-variable name exposed to the setup/action process. */
  variable: string
  /** Opaque id in Cognia's OS-keyring-backed credential store. */
  keyringRef: string
}

export type ProjectEnvironmentInitializationStatus =
  "never" | "running" | "succeeded" | "failed" | "bypassed" | "cancelled"

export interface ProjectEnvironmentInitialization {
  status: ProjectEnvironmentInitializationStatus
  scope: "local" | "managedWorktree"
  executionRoot: string
  startedAt: number
  completedAt?: number
  exitCode?: number
  /** Redacted diagnostic summary; command output and secrets are never stored here. */
  error?: string
}

/**
 * A project-scoped local execution definition. Definitions are device-local;
 * secret values remain exclusively in the OS keyring and are referenced by id.
 */
export interface ProjectEnvironment {
  id: string
  projectId: string
  name: string
  isEnabled: boolean
  setupScript: ProjectEnvironmentScript
  actions: ProjectEnvironmentAction[]
  /** Non-sensitive values only. */
  variables: Record<string, string>
  keyringReferences: ProjectEnvironmentKeyringReference[]
  /** Host-enforced execution policy. Legacy desktop definitions omit this field. */
  policy?: ProjectEnvironmentPolicy
  /**
   * The project's runtime-environment selection (ADR-0182). Absent: the project
   * never opted in, and runs on the existing execution path whatever the
   * deployment offers. Non-indexed, so no schema version bump.
   */
  runtime?: ProjectRuntimeSelection
  lastInitialization?: ProjectEnvironmentInitialization
  initializationHistory?: ProjectEnvironmentInitialization[]
  createdAt: number
  updatedAt: number
}

export interface ProjectEnvironmentPolicy {
  requiredRuntimeCapabilities: Array<
    "filesystem" | "process" | "terminal" | "editor" | "browser" | "network_policy" | "sandbox"
  >
  allowedDomains?: string[]
  /** Explicit egress posture; cloud execution defaults to `off`. */
  network?: "off" | "allowlist" | "on"
  requireSandbox?: boolean
  cacheKey?: string
}

/**
 * Which sandbox environment a project runs in (ADR-0182). Choosing one is the
 * project-level opt-in; every field but `source` has a deployment default.
 */
export interface ProjectRuntimeSelection {
  /**
   * `auto`: the repository's approved declaration, else the deployment
   * default. `catalog`: exactly this catalog entry — an explicit choice that
   * fails closed when the entry is unavailable instead of falling through.
   */
  source: { kind: "auto" } | { kind: "catalog"; catalogEntryId: string }
  /** Absent: the chosen entry's first offered size class. */
  sizeClassId?: string
  /** Absent: `persistent`. */
  lifecycle?: SandboxLifecycleKind
  /**
   * An isolation tier the project requires. Setting it makes isolation
   * mandatory: an infrastructure fault refuses the run instead of falling
   * back to the unsandboxed path.
   */
  isolationMinimum?: IsolationTier
  /** Stay on a retained agent bundle instead of following the release. */
  bundlePin?: { digest: string; releaseTag: string }
  /** Baseline egress preset ids. Absent: every preset the baseline defines. */
  egressPresetIds?: string[]
  /** Run the browser sidecar beside the sandbox. Absent: off. */
  browserSidecar?: boolean
  /**
   * Desktop only: run agents in a local container. Absent: off. Local
   * containers keep the user's own credentials (ADR-0182 desktop exception).
   */
  localContainer?: boolean
  updatedAt: number
}

/** Immutable snapshot selected by a durable AgentTeam run. */
export interface ProjectEnvironmentVersion {
  id: string
  environmentId: string
  projectId: string
  version: number
  name: string
  setupScript: ProjectEnvironmentScript
  actions: ProjectEnvironmentAction[]
  variables: Record<string, string>
  keyringReferences: ProjectEnvironmentKeyringReference[]
  policy: ProjectEnvironmentPolicy
  /** The runtime selection at snapshot time; absent when the project had none. */
  runtime?: ProjectRuntimeSelection
  createdAt: number
}

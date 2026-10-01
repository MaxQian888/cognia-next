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
  /**
   * The setup fingerprint this run satisfied (see `ProjectEnvironmentSetupReuse`).
   * Written only on a successful run of an environment that opted into reuse;
   * a later setup in the same root and scope with the same fingerprint may be
   * skipped on the strength of it.
   */
  fingerprint?: string
}

/**
 * Opt-in reuse of a successful setup, the environment analogue of starting
 * from a golden snapshot instead of booting from scratch.
 *
 * Every chat turn and scheduled fire bound to an environment runs its setup
 * script first, so a `pnpm install` that has nothing to do still costs its full
 * start-up on every turn. With reuse on, a setup is skipped when the latest
 * setup recorded for the same execution root and scope succeeded with the same
 * fingerprint and every declared output still exists.
 *
 * The fingerprint covers the setup script (every OS variant), the plain
 * variables, the keyring *references* (not their secret values), the policy
 * (so bumping `policy.cacheKey` invalidates it) and the content of each
 * `inputs` file. Rotating a secret therefore does not invalidate it on its own:
 * the manual "Run setup" always runs and records a fresh success, and changing
 * `policy.cacheKey` (read nowhere else) invalidates every earlier record.
 *
 * Off unless enabled: a setup script may have effects outside its root (a
 * service it starts, a login it performs) that no fingerprint can see, so only
 * the user can say a repeat is redundant. The manual "Run setup" button always
 * runs.
 */
export interface ProjectEnvironmentSetupReuse {
  enabled: boolean
  /** Root-relative files whose content decides whether setup must re-run (e.g. `pnpm-lock.yaml`). */
  inputs: string[]
  /** Root-relative paths setup produces; if any is missing, setup runs again (e.g. `node_modules`). */
  outputs: string[]
}

/** A bounded standalone Agent that repairs setup before readiness checks pass. */
export interface ProjectEnvironmentBootstrapAgent {
  enabled: boolean
  /** Independent implementation installed on the execution host. */
  runtime?: "native" | "bash" | "powershell"
  /** Executable or standalone script on the execution host. */
  binary?: string
  task: string
  baseUrl: string
  model: string
  /** Variable name only. The host obtains its value from a keyring reference. */
  apiKeyEnv?: string
  checks: Array<{ name: string; command: string }>
  maxSteps?: number
  totalTimeoutSecs?: number
  commandTimeoutSecs?: number
  maxOutputBytes?: number
  maxContextBytes?: number
  maxResponseBytes?: number
  systemPrompt?: string
  modelOptions?: ProjectEnvironmentBootstrapModelOptions
  context?: ProjectEnvironmentBootstrapContext
  tools?: ProjectEnvironmentBootstrapTools
  reuse?: { inputs?: string[]; outputs?: string[] }
  /** Invalid advanced editor input is retained so save/run cannot silently ignore it. */
  advancedOptionsDraft?: string
}

export interface ProjectEnvironmentBootstrapModelOptions {
  auth?: "bearer" | "header" | "none"
  apiKeyHeader?: string
  endpointPath?: string
  requestTimeoutSecs?: number
  maxTokens?: number
  temperature?: number
  topP?: number
  seed?: number
  reasoningEffort?: string
  thinking?: Record<string, unknown>
  extraBody?: Record<string, unknown>
  headers?: Record<string, string>
  headersEnv?: Record<string, string>
  stream?: boolean
  showThinking?: boolean
}

export interface ProjectEnvironmentBootstrapContext {
  contextWindowTokens?: number
  autoCompact?: boolean
  compactThresholdTokens?: number
  compactRetainTokens?: number
  compactMaxTokens?: number
  compactRetries?: number
  maxOverflowRetries?: number
  pruneToolResults?: boolean
  pruneThresholdBytes?: number
  pruneHeadBytes?: number
  pruneTailBytes?: number
}

export interface ProjectEnvironmentBootstrapTools {
  shell?: boolean
  editor?: boolean
  profile?: "native" | "dsh"
  shellExecutable?: string
  shellArgs?: string[]
  /** Non-sensitive values only; provider/header credential variables are forbidden. */
  environment?: Record<string, string>
  maxFileBytes?: number
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
  /** Absent or disabled: setup runs on every turn, as it always has. */
  setupReuse?: ProjectEnvironmentSetupReuse
  /** Optional adaptive initialization, executed before the full Agent runtime. */
  bootstrapAgent?: ProjectEnvironmentBootstrapAgent
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
  /** Setup reuse at snapshot time; absent when the environment never opted in. */
  setupReuse?: ProjectEnvironmentSetupReuse
  /** Optional adaptive initialization, executed before the full Agent runtime. */
  bootstrapAgent?: ProjectEnvironmentBootstrapAgent
  createdAt: number
}

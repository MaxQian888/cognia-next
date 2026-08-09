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
  createdAt: number
}

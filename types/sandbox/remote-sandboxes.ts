/**
 * Remote sandbox providers (ADR-0221), as the brain and the settings UI see
 * them.
 *
 * Two readers share these shapes: the "Remote sandboxes" settings section on
 * a desktop (`remote_sandboxes_get`/`_set`, `crates/cognia-companion/src/
 * remote_sandboxes.rs`), and every Host's driver status
 * (`environment_driver_status` → `providers`), which is what run placement
 * chooses a provider from. The Rust types are the authority; these read them
 * back.
 */

import type { IsolationTier } from "./environment-spec"

export type SandboxProviderKind = "e2b" | "kubernetes"

/** Where a provider's account credential comes from. Exactly one key. */
export type SandboxProviderCredentialSource =
  | { env: string }
  | { file: string }
  /** The desktop's encrypted secret store; the id is `remote-sandbox:<slug>`. */
  | { secretId: string }

export interface SandboxProviderLimits {
  /** Live instances at once, 1–256. Default 4. */
  maxConcurrent: number
  /** An instance's hard lifetime, 300–86400 s. Default 7200. */
  maxLifetimeSecs: number
  /** A persistent instance with no session is destroyed after this, 60–86400 s. Default 600. */
  idleTimeoutSecs: number
}

export const DEFAULT_SANDBOX_PROVIDER_LIMITS: SandboxProviderLimits = Object.freeze({
  maxConcurrent: 4,
  maxLifetimeSecs: 7200,
  idleTimeoutSecs: 600,
})

export const SANDBOX_PROVIDER_LIMIT_BOUNDS = Object.freeze({
  maxConcurrent: [1, 256],
  maxLifetimeSecs: [300, 86_400],
  idleTimeoutSecs: [60, 86_400],
} as const satisfies Record<keyof SandboxProviderLimits, readonly [number, number]>)

/** `E2bSettings` in `crates/cognia-sandbox-pool/src/remote/e2b/mod.rs`. */
export interface E2bProviderSettings {
  apiUrl?: string
  domain?: string
  /** Registries whose pull credentials may be handed to E2B's template build. */
  delegatedRegistries?: string[]
  templatePrefix?: string
  templateBuildTimeoutSecs?: number
}

/**
 * What a Kubernetes cluster enforces for egress. `network-policy` cannot
 * match hostnames, so an `allowlist` there runs unenforced and is labelled
 * so; only `cilium` enforces one.
 */
export type KubernetesEgressMode = "none" | "network-policy" | "cilium"

/** `KubernetesSettings` in `crates/cognia-sandbox-pool/src/remote/kubernetes.rs`. */
export interface KubernetesProviderSettings {
  connection: "inCluster" | "kubeconfig"
  context?: string
  namespace: string
  runtimeClasses?: { gvisor?: string; vm?: string; container?: string }
  egress?: KubernetesEgressMode
  nodeSelector?: Record<string, string>
  serviceAccountName?: string
  podReadyTimeoutSecs?: number
}

interface SandboxProviderConfigBase {
  /** `[a-z0-9][a-z0-9-]{0,31}`, never `local`. */
  id: string
  label?: string
  credential?: SandboxProviderCredentialSource
  limits?: Partial<SandboxProviderLimits>
}

export type SandboxProviderConfig =
  | (SandboxProviderConfigBase & { kind: "e2b"; settings: E2bProviderSettings })
  | (SandboxProviderConfigBase & { kind: "kubernetes"; settings: KubernetesProviderSettings })

/** The providers file a server names in `COGNIA_SANDBOX_PROVIDERS_FILE`, and a desktop's settings carry. */
export interface SandboxProvidersFile {
  version: 1
  providers: SandboxProviderConfig[]
  /** The remote provider `auto` placement uses. */
  defaultProviderId?: string
}

export interface RegistryRule {
  registry: string
  repositoryPrefix: string
  insecure?: boolean
}

/** A desktop's "Remote sandboxes" settings document. */
export interface DesktopRemoteSandboxes {
  version: 1
  providers: SandboxProvidersFile
  /** Registries (and repository prefixes) project images may come from. */
  registryAllowlist: RegistryRule[]
}

/**
 * Whether remote sandboxes can run on this desktop.
 *
 * `bundle_unpinned` is intentional dormancy: a build with no digest-pinned
 * agent bundle cannot inject the agent into any image, so it installs
 * nothing whatever the settings say. Labelled in the settings section and
 * pinned by `an_unpinned_build_keeps_remote_sandboxes_off` (Rust) and the
 * section's own test.
 */
export type DesktopRemoteSandboxesAvailability = "active" | "no_providers" | "bundle_unpinned"

export interface RemoteSandboxesBundle {
  registry: string
  repository: string
  digest: string
  releaseTag: string
}

export interface RemoteSandboxesView {
  settings: DesktopRemoteSandboxes
  availability: DesktopRemoteSandboxesAvailability
  bundle: RemoteSandboxesBundle | null
  /** Credential ids the settings name that have a stored value. Values are never returned. */
  storedSecretIds: string[]
  /** The saved settings differ from what the running app installed; they apply at the next start. */
  restartRequired: boolean
  /** Why the pool was asked for at startup and did not install. */
  installError: string | null
}

export interface RemoteSandboxesUpdate {
  settings: DesktopRemoteSandboxes
  /** By `secretId`: a string stores it, `null` deletes it, absent leaves it. */
  secrets?: Record<string, string | null>
}

/** Filesystem checkpoints and process suspension are independent provider capabilities. */
export interface SandboxSnapshotCapabilities {
  filesystemCheckpoint: boolean
  forkFromCheckpoint: boolean
  pauseResume: boolean
  memoryResume: boolean
}

/** One driver of a Host's provider set, as `environment_driver_status` reports it. */
export interface SandboxProviderView {
  /** `local` for the Host's own driver. */
  id: string
  driver: string
  label?: string
  remote: boolean
  /** The provider `auto` placement uses. */
  isDefault: boolean
  reachable: boolean
  availableTiers: IsolationTier[]
  /** Older hosts omit this; absence must not be treated as checkpoint support. */
  capabilities?: SandboxSnapshotCapabilities
  unavailableCode?: string
  limits?: SandboxProviderLimits
  usage?: { instances: number; sessions: number }
}

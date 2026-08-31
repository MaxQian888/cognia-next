/**
 * Shared sandbox contracts (Epic 5 — ADR-0020 / ADR-0028 convergence).
 *
 * Three previously-separate settings decided where a session's work ran:
 * `sandboxTier` (`"os" | "microvm"`) chose the shell/file backend,
 * `computerUseTarget` (`"local" | {connectionId}`) chose the GUI backend, and
 * the sandbox-connection row itself was Docker-shaped. Nothing tied them
 * together, so a `cua-desktop` connection could drive the GUI while `Bash`
 * still ran on the host.
 *
 * {@link SandboxSessionBinding} is the single resolved answer to "where does
 * this session's work run", and {@link SandboxConnectionRow} is the
 * provider-neutral connection it points at. Runtime resolution, validation and
 * migration live in `lib/sandbox/` — this module is types only.
 */

// ─── Session binding ────────────────────────────────────────────────────────

/**
 * Where `Bash` / `Read` / `Edit` / `Write` run.
 *
 * - `"os"` — the per-platform OS sandbox (sandbox-exec / bwrap / windows-codex).
 * - `"microvm"` — the Firecracker workspace backend (`plugins/e2b-sandbox`).
 * - `"cua-desktop"` — inside the bound sandbox connection, alongside the GUI.
 */
export type SandboxShellTier = "os" | "microvm" | "cua-desktop"

/** Where Computer Use actions land: the host desktop, or a bound connection. */
export type SandboxComputerTarget = "local" | "bound"

/**
 * The resolved execution binding for one session. Produced by
 * `lib/sandbox/binding.ts:resolveSandboxSessionBinding` from the session,
 * character and app-settings layers; consumed by the tool-routing layer so
 * shell/file and GUI work can never disagree about their target.
 *
 * Invariants (enforced by `validateSandboxSessionBinding`):
 *   1. `computerTarget === "bound"` requires `connectionId`.
 *   2. `shellTier === "cua-desktop"` requires `computerTarget === "bound"` —
 *      the tier means "run everything in that desktop", so it always binds
 *      both shell/file and GUI execution to the same connection.
 */
export interface SandboxSessionBinding {
  shellTier: SandboxShellTier
  computerTarget: SandboxComputerTarget
  /** Required whenever `computerTarget` is `"bound"`. */
  connectionId?: string
}

// ─── Connection: provider / driver split ────────────────────────────────────

/**
 * Who owns the sandbox machine.
 *
 * - `"docker"` — a local container (the original Phase 1 behaviour).
 * - `"cua-cloud"` — a cua.ai-managed cloud desktop.
 * - `"lume"` — a local Lume VM.
 */
export type SandboxConnectionProvider = "docker" | "cua-cloud" | "lume"

/**
 * How we talk to it, orthogonal to who owns it.
 *
 * - `"computer-server"` — the HTTP/WebSocket `computer-server` protocol.
 * - `"cua-driver"` — the cua driver process, run under an app-owned
 *   supervisor; owns element/session state and needs no global install.
 */
export type SandboxConnectionDriver = "computer-server" | "cua-driver"

/** A single host directory bound into the container. */
export interface SandboxWorkspaceMount {
  hostPath: string
  containerPath: string
}

export interface DockerSandboxConfig {
  /** Container image, e.g. `ghcr.io/trycua/cua-xfce:latest`. */
  image: string
  /** Host the container is reachable on. Local Docker is always `127.0.0.1`. */
  host: string
  /** Mapped host port for the container's `computer-server`; 0 until started. */
  port: number
  /** Docker container id once created. */
  containerId?: string

  // ── Container policy, frozen in at create time ──
  //
  // Docker fixes all four when the container is made. `docker exec` cannot
  // change a running container's network mode or its cpu/memory ceiling, so a
  // per-call policy request can only be *attested* against these, never
  // enforced on top of them. They are recorded here so an execution asking for
  // something stricter than the machine actually got is refused rather than
  // run under a weaker confinement than the caller believes.

  /** `--network`. Absent means Docker's default bridge network. */
  networkMode?: string
  /** `--cpus`, e.g. `"1.5"`. Absent means the cpu allowance is uncapped. */
  cpus?: string
  /** `--memory`, in MiB. Absent means memory is uncapped. */
  memoryMb?: number
  /**
   * The one host directory visible inside the machine. Host paths mean nothing
   * to a container, so without a mount there is no path a workspace write can
   * legitimately target.
   */
  workspaceMount?: SandboxWorkspaceMount
}

export interface CuaCloudSandboxConfig {
  /** cua.ai instance name. */
  instanceName: string
  /** API base, for self-hosted control planes. Defaults to cua.ai's. */
  apiHost?: string
  /** Region hint passed at create time. */
  region?: string
  /** Image/template the instance was created from. */
  image?: string
  /** Provider-assigned instance id, once created. */
  instanceId?: string
  /**
   * Host/port the driver connects to once the instance is running. Never
   * includes a token — credentials are resolved from the keyring per call.
   */
  host?: string
  port?: number
}

export interface LumeSandboxConfig {
  /** Lume VM name. */
  vmName: string
  /** Image the VM was created from. */
  image?: string
  /** Discovered once the VM reports ready. */
  host?: string
  port?: number
  /** Resource ceiling applied at create time. */
  cpu?: number
  memoryMb?: number
}

/** Provider-specific configuration, discriminated by the row's `provider`. */
export type SandboxProviderConfig =
  | ({ provider: "docker" } & DockerSandboxConfig)
  | ({ provider: "cua-cloud" } & CuaCloudSandboxConfig)
  | ({ provider: "lume" } & LumeSandboxConfig)

// ─── Normalized lifecycle state ─────────────────────────────────────────────

/**
 * One vocabulary for every provider. Transient states (`*ing`) exist so the UI
 * can show progress without each provider inventing its own words.
 */
export type SandboxLifecycleState =
  | "uninitialized"
  | "creating"
  | "stopped"
  | "starting"
  | "running"
  | "suspending"
  | "suspended"
  | "resuming"
  | "stopping"
  | "deleting"
  | "error"

/** Health probe outcome. Narrower than lifecycle state and updated far more often. */
export type SandboxHealthStatus = "unknown" | "starting" | "ok" | "unreachable" | "error"

// ─── Capabilities ───────────────────────────────────────────────────────────

/**
 * Every operation a provider adapter may expose. `connect` is separate from
 * `start` because a cloud instance can be reachable without us having started
 * it, and `health` is separate from both because it must work in any state.
 */
export type SandboxLifecycleOperation =
  | "create"
  | "connect"
  | "start"
  | "suspend"
  | "resume"
  | "stop"
  | "delete"
  | "health"
  | "gui"
  | "workspaceRead"
  | "workspaceExec"

/**
 * What a given provider/driver pair actually supports. A `false` entry is a
 * contract, not a hint: the lifecycle guard refuses the call with a typed
 * capability error rather than silently running it on the host.
 */
export type SandboxCapabilities = Readonly<Record<SandboxLifecycleOperation, boolean>>

/**
 * Pointer to a secret in the OS keyring. The secret itself — and any
 * token-bearing URL — never reaches Dexie, logs or audit records.
 */
export interface SandboxCredentialRef {
  keyringService: string
  keyringAccount: string
}

// ─── Persisted row ──────────────────────────────────────────────────────────

/**
 * One sandbox connection. Target selectors on `Character` / `ChatSession` /
 * workflow nodes reference `id`.
 *
 * The four legacy fields at the bottom are dual-written for one compatibility
 * release so a downgrade to the pre-Epic-5 build still finds a working Docker
 * row. They mirror `config` and are never read by new code.
 */
export interface SandboxConnectionRow {
  /** uuid primary key — the value target selectors reference. */
  id: string
  /** User-visible label, e.g. "home-docker". */
  name: string
  provider: SandboxConnectionProvider
  driver: SandboxConnectionDriver
  config: SandboxProviderConfig
  state: SandboxLifecycleState
  capabilities: SandboxCapabilities
  /**
   * Which release of the default capability matrix `capabilities` was derived
   * from. A row behind the current revision is recomputed from defaults on
   * read, which is the only way a connection created before an adapter existed
   * can ever learn that one now does. Absent means revision 1.
   */
  capabilitiesRevision?: number
  /** Present only for providers that authenticate (cua.ai Cloud). */
  credentialRef?: SandboxCredentialRef
  lastHealthStatus: SandboxHealthStatus
  lastHealthError?: string
  lastHealthCheckAt?: number
  createdAt: number
  updatedAt: number

  // ── Legacy compatibility mirrors (removed one release after v143) ──
  /** @deprecated mirror of `config.image`; read `config` instead. */
  image?: string
  /** @deprecated mirror of `config.host`; read `config` instead. */
  host?: string
  /** @deprecated mirror of `config.port`; read `config` instead. */
  port?: number
  /** @deprecated mirror of `config.containerId`; read `config` instead. */
  containerId?: string
}

/** The pre-v143 Docker-only row, as it exists in an un-migrated database. */
export interface LegacySandboxConnectionRow {
  id: string
  name: string
  provider: "docker"
  image: string
  host: string
  port: number
  containerId?: string
  lastHealthStatus: SandboxHealthStatus
  lastHealthError?: string
  lastHealthCheckAt?: number
  createdAt: number
  updatedAt: number
}

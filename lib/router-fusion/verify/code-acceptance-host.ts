/**
 * The host's {@link AcceptancePort}: running a `code_fixture` acceptance
 * profile in a sandbox (ADR-0188 B4, WP-D3; ADR-0182/0183 for the tiers).
 *
 * Only a report this module produced can accept delegated work, so everything
 * it does is about making that report mean something:
 *
 * - **The command is the approved one.** It comes from
 *   `resolveAcceptanceProfile` (WP-D2) — the `.cognia/workspace.json` profile
 *   the user approved at its command hash — and nothing here can widen it. An
 *   unapproved or changed command is refused with its own code and is not run.
 * - **It runs on the revision it claims.** The staged worktree of that exact
 *   revision, provisioned by `workspace-patch.ts`; never the user's checkout,
 *   so a test that writes files cannot touch a person's work, and a report
 *   about v1 cannot be presented for v2 (DEL-03 is then enforced in the
 *   package by `judgeRuntimeAcceptance`).
 * - **It runs in the strongest tier this device has**, microVM → container →
 *   OS sandbox, and the tier is recorded in the report. No tier is
 *   `SANDBOX_UNAVAILABLE`: delegated code is not run unconfined, ever.
 * - **With no network and bounded resources** (SAFE-02): the container spec
 *   carries `--network none`, no docker socket, no home or credential mount,
 *   a cpu, memory and pids ceiling and a wall-clock timeout; the OS and
 *   microVM payloads carry `network: "off"` and the same ceilings. The spec
 *   is built by a pure function so a test asserts the real thing rather than
 *   a description of it.
 * - **The report is collected, not believed.** Only the profile's declared
 *   path is read, resolved inside the worktree (the Rust read canonicalizes
 *   and refuses an escape), capped at {@link ACCEPTANCE_REPORT_MAX_BYTES}; a
 *   missing, truncated or malformed report is `inconclusive`, never a pass.
 *   The parsing and the DEL-02 rules are the package's
 *   (`buildCodeAcceptanceReport`), so the host decides nothing about what a
 *   test run proves.
 *
 * WP-D6 is adding the Rust guarantees underneath (a network-off flag, a
 * report-path option, resource limits). The runner is injectable and its spec
 * is pure, so reconciling with those is a change in
 * {@link defaultAcceptanceSandboxHost}, not in the port.
 */

import {
  SANDBOX_TIERS,
  buildCodeAcceptanceReport,
  type AcceptancePort,
  type AcceptanceReportFormat,
  type AcceptanceRunOutcome,
  type SandboxTier,
} from "@cognia/router-fusion"

import type { ArtifactStore } from "@cognia/router-fusion"

import { normalizeDelegateHostPath } from "../tools/delegate-tool-policy"
import { WORKSPACE_REVISION_COMMANDS, type ConfinedFileReadAnswer } from "../tools/workspace-patch"
import type { ApprovedAcceptanceProfile } from "./acceptance-profiles"

/** Bytes of the declared report the host will collect. Bigger is `inconclusive`. */
export const ACCEPTANCE_REPORT_MAX_BYTES = 4 * 1024 * 1024
/** Characters of stdout and stderr kept for the run's log artifact. */
export const ACCEPTANCE_LOG_TAIL_CHARS = 8_000

/** The ceilings every acceptance run carries, whatever tier runs it. */
export interface AcceptanceResourceLimits {
  /** CPU seconds. Derived from the profile's timeout unless a caller overrides it. */
  cpuSeconds: number
  memoryMb: number
  /** Processes/threads the run may create; a fork bomb hits this, not the machine. */
  pids: number
  /** Wall clock, from the profile. */
  timeoutMs: number
}

export const ACCEPTANCE_DEFAULT_LIMITS = {
  memoryMb: 4_096,
  pids: 512,
  /** CPU seconds never exceed the wall clock by more than this factor. */
  cpuOversubscription: 2,
} as const

/** Where a sandbox mounts the worktree, shared with ADR-0183's supervisor. */
export const ACCEPTANCE_WORKSPACE_FOLDER = "/workspace"

/**
 * The environment an acceptance command runs with. Fixed and minimal: the
 * host's own environment is never inherited, so a token in the developer's
 * shell cannot reach a test that a model wrote.
 */
export const ACCEPTANCE_ENV: Readonly<Record<string, string>> = Object.freeze({
  CI: "1",
  COGNIA_ACCEPTANCE: "1",
  LANG: "C.UTF-8",
  LC_ALL: "C.UTF-8",
  HOME: "/tmp/cognia-acceptance",
  PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
  TERM: "dumb",
  NO_COLOR: "1",
})

export interface AcceptanceRunSpec {
  runId: string
  logicalStepId: string
  tier: SandboxTier
  /** The staged worktree of the revision under test, on this host. */
  worktreeRoot: string
  /** Repository-relative working directory, `.` for the root. */
  cwd: string
  /** argv, run without a shell. */
  argv: string[]
  env: Record<string, string>
  limits: AcceptanceResourceLimits
  /** Repository-relative path of the report the command writes. */
  reportPath: string
  reportMaxBytes: number
  /** A pinned image reference, for the container tier. */
  image: string | null
  signal: AbortSignal
}

/**
 * What the runner ATTESTED it enforced — not what the policy asked for
 * (WP-D6's `confinement` block). The OS tier's real guarantees differ by
 * platform: macOS has `(deny network*)` but no pids cap, Linux has
 * `--unshare-net` but no pids cap, and Windows cannot confine egress at all.
 * A report that said "os tier" without saying which of those ran would
 * overstate the evidence, so this is recorded in the VerificationReport.
 */
export interface AcceptanceConfinement {
  /** The one non-negotiable: the run really had no network. */
  networkEnforced: boolean
  backend?: string | null
  maxMemoryMb?: number | null
  maxCpuSeconds?: number | null
  /** Null when the platform has no pids cap (macOS, Linux today). */
  maxProcesses?: number | null
  platform?: string | null
}

export interface AcceptanceCommandOutcome {
  /** Null when the process did not exit on its own (killed, sandbox fault). */
  exitCode: number | null
  timedOut: boolean
  stdout: string
  stderr: string
  /** The declared report, or null when the command left none. */
  report: { content: string | null; truncated: boolean }
  /** What the runner attested; null when it attested nothing. */
  confinement?: AcceptanceConfinement | null
}

/** What a tier can do on this device right now. */
export interface AcceptanceSandboxAvailability {
  microvm: boolean
  container: boolean
  os: boolean
}

/** The summary a `sandbox_confinement` check carries into the report. */
export function confinementSummary(
  tier: SandboxTier,
  confinement: AcceptanceConfinement | null
): string {
  if (!confinement) return `tier=${tier} attested=none`
  const parts = [
    `tier=${tier}`,
    `network=${confinement.networkEnforced ? "off_enforced" : "unenforced"}`,
    `backend=${confinement.backend ?? "unknown"}`,
    `platform=${confinement.platform ?? "unknown"}`,
    `memory_mb=${confinement.maxMemoryMb ?? "unbounded"}`,
    `cpu_seconds=${confinement.maxCpuSeconds ?? "unbounded"}`,
    `processes=${confinement.maxProcesses ?? "unbounded"}`,
  ]
  return parts.join(" ")
}

export interface AcceptanceSandboxHost {
  availability(): Promise<AcceptanceSandboxAvailability>
  run(spec: AcceptanceRunSpec): Promise<AcceptanceCommandOutcome>
}

/**
 * The strongest tier available, or null. Order is the contract's, strongest
 * first (`SANDBOX_TIERS`), and a tier that reports itself unavailable is
 * skipped rather than tried and fallen back from — a fallback after a failed
 * start would run the same code under weaker isolation than was chosen.
 */
export function selectSandboxTier(availability: AcceptanceSandboxAvailability): SandboxTier | null {
  for (const tier of SANDBOX_TIERS) {
    if (availability[tier]) return tier
  }
  return null
}

/** The limits one profile runs under. */
export function acceptanceLimitsFor(
  timeoutMs: number,
  overrides?: Partial<AcceptanceResourceLimits>
): AcceptanceResourceLimits {
  const wallMs = Math.max(1_000, timeoutMs)
  return {
    cpuSeconds: Math.max(
      1,
      Math.ceil((wallMs / 1000) * ACCEPTANCE_DEFAULT_LIMITS.cpuOversubscription)
    ),
    memoryMb: ACCEPTANCE_DEFAULT_LIMITS.memoryMb,
    pids: ACCEPTANCE_DEFAULT_LIMITS.pids,
    timeoutMs: wallMs,
    ...overrides,
  }
}

// ── the container image (ADR-0182) ───────────────────────────────────────────

/**
 * A pinned reference, or null. `registry/repository@sha256:<64 hex>` and
 * nothing else: a tag can point at a different build tomorrow, and a report
 * that says "it passed in this image" then means nothing.
 */
export function pinnedImageOrNull(reference: string | null | undefined): string | null {
  if (!reference) return null
  const at = reference.lastIndexOf("@")
  if (at <= 0) return null
  const digest = reference.slice(at + 1)
  return /^sha256:[0-9a-f]{64}$/.test(digest) && reference.slice(0, at).includes("/")
    ? reference
    : null
}

export interface ProjectContainerImageInput {
  projectId: string
  /** The workspace, for the trust gate and the declaration's approval key. */
  project?: { roots?: unknown } | null
  /** The run's execution root; the declaration is read from it. */
  executionRoot?: string | null
  /** Seam: `prepareRunEnvironment` and its sources in production. */
  resolve?: () => Promise<{ kind: string; placement?: { spec?: { image?: unknown } } }>
}

/**
 * The image the project's runtime environment resolves to (ADR-0182), as a
 * pinned reference — or null when the project selected no environment, when
 * the deployment could not place one, or when what came back is not pinned.
 *
 * Null is the ordinary answer, not a failure: the container tier is then not
 * offered and the acceptance run takes the next tier down.
 */
export async function resolveProjectContainerImage(
  input: ProjectContainerImageInput
): Promise<string | null> {
  try {
    const outcome = input.resolve
      ? await input.resolve()
      : await (async () => {
          const { prepareRunEnvironment, defaultRunEnvironmentSources } =
            await import("@/lib/sandbox/run-environment")
          return prepareRunEnvironment(
            {
              agentId: `router-fusion-delegate:${input.projectId}`,
              projectId: input.projectId,
              project: (input.project ?? null) as never,
              executionRoot: input.executionRoot ?? null,
              // Nobody is watching an acceptance run: it must not be handed a
              // deployment default in place of what the repository declared.
              surface: "unattended",
            },
            defaultRunEnvironmentSources()
          )
        })()
    if (outcome.kind !== "placed") return null
    const image = outcome.placement?.spec?.image as
      { registry?: string; repository?: string; digest?: string } | undefined
    if (!image?.registry || !image.repository || !image.digest) return null
    return pinnedImageOrNull(`${image.registry}/${image.repository}@${image.digest}`)
  } catch {
    // An unreachable pool, a locked vault, a project that is gone: the tier is
    // simply not offered.
    return null
  }
}

// ── the container spec (SAFE-02) ─────────────────────────────────────────────

export interface AcceptanceContainerMount {
  source: string
  target: string
  readOnly: boolean
}

/**
 * Everything the container tier is asked for, as data. A test asserts this
 * object; the adapter only translates it, so "no network" and "no socket" are
 * checkable facts rather than a promise in a comment.
 */
export interface AcceptanceContainerSpec {
  image: string
  argv: string[]
  workingDir: string
  /** Always `none`: an acceptance run has no reason to reach anything. */
  network: "none"
  /** Exactly one: the staged worktree. No socket, no home, no credential path. */
  mounts: AcceptanceContainerMount[]
  env: Record<string, string>
  cpus: string
  memoryMb: number
  pidsLimit: number
  timeoutMs: number
  capDrop: string[]
  securityOpt: string[]
  /** The container is thrown away with everything it wrote outside the mount. */
  autoRemove: true
}

function joinContainerPath(cwd: string): string {
  const relative = cwd
    .trim()
    .replace(/^\.\/?/, "")
    .replace(/\/+$/, "")
  return relative.length === 0
    ? ACCEPTANCE_WORKSPACE_FOLDER
    : `${ACCEPTANCE_WORKSPACE_FOLDER}/${relative}`
}

export function buildAcceptanceContainerSpec(spec: AcceptanceRunSpec): AcceptanceContainerSpec {
  if (!spec.image) throw new Error("the container tier needs a pinned image")
  return {
    image: spec.image,
    argv: [...spec.argv],
    workingDir: joinContainerPath(spec.cwd),
    network: "none",
    mounts: [{ source: spec.worktreeRoot, target: ACCEPTANCE_WORKSPACE_FOLDER, readOnly: false }],
    env: { ...spec.env },
    cpus: String(Math.max(1, Math.ceil(spec.limits.cpuSeconds / (spec.limits.timeoutMs / 1000)))),
    memoryMb: spec.limits.memoryMb,
    pidsLimit: spec.limits.pids,
    timeoutMs: spec.limits.timeoutMs,
    capDrop: ["ALL"],
    securityOpt: ["no-new-privileges"],
    autoRemove: true,
  }
}

/** Paths a mount may never name, whatever asked for it. */
const FORBIDDEN_MOUNT_SOURCES = [
  /docker\.sock$/i,
  /containerd\.sock$/i,
  /podman\.sock$/i,
  /^\/proc(\/|$)/,
  /^\/sys(\/|$)/,
  /^\/var\/run(\/|$)/,
  /(^|\/)\.(ssh|aws|gnupg|kube|docker|config)(\/|$)/i,
]

/**
 * Why a container spec must not be run, or null. Checked by the adapter
 * before it talks to the runtime: a spec is data, and data can be built
 * wrong, so the last thing before the runtime re-reads the invariants.
 */
export function containerSpecRefusal(spec: AcceptanceContainerSpec): string | null {
  if (spec.network !== "none") return "an acceptance container must have no network"
  if (spec.mounts.length !== 1)
    return "an acceptance container mounts the worktree and nothing else"
  const [mount] = spec.mounts
  if (mount.target !== ACCEPTANCE_WORKSPACE_FOLDER) {
    return `an acceptance container mounts the worktree at ${ACCEPTANCE_WORKSPACE_FOLDER}`
  }
  if (FORBIDDEN_MOUNT_SOURCES.some((pattern) => pattern.test(mount.source))) {
    return `refused mount source: ${mount.source}`
  }
  if (spec.memoryMb <= 0 || spec.pidsLimit <= 0 || spec.timeoutMs <= 0) {
    return "an acceptance container runs under cpu, memory, pids and time ceilings"
  }
  return null
}

// ── the OS / microVM payload ─────────────────────────────────────────────────

/** The `sandbox_exec` payload shape (`MicrovmExecPayload`), built as data. */
export interface AcceptanceExecPayload {
  tool: string
  command: {
    argv: string[]
    cwd: string
    env: Record<string, string>
    stdin: null
    timeout: number
  }
  request: {
    writable: string[]
    readable: string[]
    targetFiles: string[]
    maxCpuSeconds: number
    maxMemoryMb: number
    network: "off"
    networkHosts: string[]
  }
}

export function buildAcceptanceExecPayload(spec: AcceptanceRunSpec): AcceptanceExecPayload {
  const relative = spec.cwd
    .trim()
    .replace(/^\.\/?/, "")
    .replace(/\/+$/, "")
  return {
    tool: "router_fusion_acceptance",
    command: {
      argv: [...spec.argv],
      cwd: relative.length === 0 ? spec.worktreeRoot : `${spec.worktreeRoot}/${relative}`,
      env: { ...spec.env },
      stdin: null,
      timeout: Math.ceil(spec.limits.timeoutMs / 1000),
    },
    request: {
      // The staged worktree and nothing else. A test may write inside it; it
      // is thrown away with the run.
      writable: [spec.worktreeRoot],
      readable: [spec.worktreeRoot],
      targetFiles: [],
      maxCpuSeconds: spec.limits.cpuSeconds,
      maxMemoryMb: spec.limits.memoryMb,
      network: "off",
      networkHosts: [],
    },
  }
}

// ── the tiers ────────────────────────────────────────────────────────────────

/** The `MicrovmResult` shape the OS and microVM bridges answer with. */
export interface AcceptanceExecResult {
  exit_code: number
  stdout: string
  stderr: string
  duration: number
  timed_out: boolean
  stdout_truncated?: boolean
  stderr_truncated?: boolean
  /** WP-D6's attestation of what the runner actually enforced. */
  confinement?: {
    networkEnforced?: boolean
    backend?: string | null
    maxMemoryMb?: number | null
    maxCpuSeconds?: number | null
    maxProcesses?: number | null
    platform?: string | null
  } | null
}

/** The runner's exit code for "this machine cannot confine the run". */
export const SANDBOX_CONFINEMENT_UNAVAILABLE_EXIT = 3

/** What the report read answers (WP-D6's `read_report_file`, via WP-C). */
export type AcceptanceReportRead =
  | { kind: "ok"; content: string }
  /** The command wrote no report: the DEL-02 input, not an error. */
  | { kind: "missing" }
  /** Past the cap. Refused rather than truncated, so it is never half-parsed. */
  | { kind: "too_large" }
  | { kind: "refused"; code: string }

/**
 * A one-shot container for one acceptance run: create, run, throw away.
 *
 * Kept behind an interface because the spec carries ceilings today's
 * `cua_sandbox_*` commands cannot express (a pids limit, `--cap-drop ALL`,
 * `no-new-privileges`). A runtime that cannot honour the whole spec must say
 * so through `available()` rather than run a weaker container under the name
 * of the container tier: the tier is written into the verification report as
 * evidence of how the code was confined.
 */
export interface AcceptanceContainerRuntime {
  available(): Promise<boolean>
  run(
    spec: AcceptanceContainerSpec,
    context: {
      runId: string
      logicalStepId: string
      /** The report's absolute path inside the container. */
      reportContainerPath: string
      reportMaxBytes: number
      signal: AbortSignal
    }
  ): Promise<AcceptanceCommandOutcome>
}

export interface AcceptanceSandboxBridges {
  /** The registered microVM exec adapter (`lib/sandbox/microvm-bridge`), or null. */
  microvm: () => Promise<{
    execute: (ownerRef: string, payload: AcceptanceExecPayload) => Promise<AcceptanceExecResult>
    preflight?: (ownerRef: string, workspaceRoot?: string) => Promise<void> | void
    release?: (ownerRef: string) => Promise<void> | void
  } | null>
  /** Whether this device's OS sandbox is actively confining (`runtime-availability`). */
  osConfined: () => Promise<boolean>
  /**
   * The desktop OS family. Windows has no OS tier at all: WP-D6's runner
   * refuses to launch when `network: "off"` is asked for, because Windows
   * cannot confine egress — so the tier is not offered rather than offered
   * and then failed.
   */
  platform: () => Promise<string>
  execOs: (payload: AcceptanceExecPayload, signal: AbortSignal) => Promise<AcceptanceExecResult>
  /**
   * The acceptance-report read: `task_workspace_revision_read` with
   * `whole: true`. Realpath-confined, capped, and refused rather than cut.
   */
  readReport: (root: string, relPath: string, maxBytes: number) => Promise<AcceptanceReportRead>
  container: AcceptanceContainerRuntime | null
}

/** Platforms whose OS tier can enforce "no network" (WP-D6). */
export const OS_TIER_PLATFORMS: ReadonlySet<string> = new Set(["macos", "darwin", "linux"])

function ownerRefFor(spec: AcceptanceRunSpec): string {
  return `router-fusion-delegate:${spec.runId}:${spec.logicalStepId}`
}

/** The acceptance sandbox over this device's tiers. Every bridge is injected. */
export function createAcceptanceSandboxHost(
  bridges: AcceptanceSandboxBridges
): AcceptanceSandboxHost {
  const readReport = async (
    root: string,
    relPath: string,
    maxBytes: number
  ): Promise<{ content: string | null; truncated: boolean }> => {
    const read = await bridges
      .readReport(root, relPath, maxBytes)
      .catch((): AcceptanceReportRead => ({ kind: "missing" }))
    switch (read.kind) {
      case "ok":
        return { content: read.content, truncated: false }
      case "too_large":
        // Not truncated content: no content at all, reported as truncated so
        // the package's rules make it inconclusive rather than a pass.
        return { content: null, truncated: true }
      case "refused":
      case "missing":
        return { content: null, truncated: false }
    }
  }

  const confinementOf = (
    tier: SandboxTier,
    result: AcceptanceExecResult
  ): AcceptanceConfinement | null => {
    const block = result.confinement
    if (!block || block.networkEnforced !== true) return null
    return {
      networkEnforced: true,
      backend: block.backend ?? null,
      maxMemoryMb: block.maxMemoryMb ?? null,
      maxCpuSeconds: block.maxCpuSeconds ?? null,
      maxProcesses: block.maxProcesses ?? null,
      platform: block.platform ?? null,
      ...(tier ? {} : {}),
    }
  }

  const execOutcome = (
    tier: SandboxTier,
    result: AcceptanceExecResult,
    report: { content: string | null; truncated: boolean }
  ): AcceptanceCommandOutcome => {
    // Exit 3 is the runner saying it could not confine the run at all. That is
    // not a test failure: nothing about the change was learned, and a report
    // built from it would claim isolation that never happened.
    if (result.exit_code === SANDBOX_CONFINEMENT_UNAVAILABLE_EXIT && !result.timed_out) {
      throw new Error(`the ${tier} sandbox could not confine the run (exit 3)`)
    }
    const confinement = confinementOf(tier, result)
    if (!confinement) {
      throw new Error(
        `the ${tier} sandbox did not attest that the run had no network; it is treated as unavailable`
      )
    }
    return {
      exitCode: result.timed_out ? null : result.exit_code,
      timedOut: result.timed_out,
      stdout: result.stdout,
      stderr: result.stderr,
      report,
      confinement,
    }
  }

  return {
    async availability(): Promise<AcceptanceSandboxAvailability> {
      const [microvm, container, osConfined, platform] = await Promise.all([
        bridges.microvm().then(
          (adapter) => adapter !== null,
          () => false
        ),
        bridges.container?.available().catch(() => false) ?? Promise.resolve(false),
        bridges.osConfined().catch(() => false),
        bridges.platform().catch(() => "unknown"),
      ])
      return {
        microvm,
        container,
        // Windows (and anything unrecognised) cannot enforce "no network", so
        // it has no OS tier — better no tier than a tier that claims one.
        os: osConfined && OS_TIER_PLATFORMS.has(platform.toLowerCase()),
      }
    },

    async run(spec: AcceptanceRunSpec): Promise<AcceptanceCommandOutcome> {
      if (spec.tier === "container") {
        if (!bridges.container) throw new Error("no container runtime is registered")
        const containerSpec = buildAcceptanceContainerSpec(spec)
        const refusal = containerSpecRefusal(containerSpec)
        if (refusal) throw new Error(refusal)
        return bridges.container.run(containerSpec, {
          runId: spec.runId,
          logicalStepId: spec.logicalStepId,
          reportContainerPath: `${ACCEPTANCE_WORKSPACE_FOLDER}/${spec.reportPath}`,
          reportMaxBytes: spec.reportMaxBytes,
          signal: spec.signal,
        })
      }

      const payload = buildAcceptanceExecPayload(spec)
      if (spec.tier === "os") {
        const result = await bridges.execOs(payload, spec.signal)
        return execOutcome(
          "os",
          result,
          await readReport(spec.worktreeRoot, spec.reportPath, spec.reportMaxBytes)
        )
      }

      const adapter = await bridges.microvm()
      if (!adapter) throw new Error("no microVM exec adapter is registered")
      const ownerRef = ownerRefFor(spec)
      try {
        await adapter.preflight?.(ownerRef, spec.worktreeRoot)
        const result = await adapter.execute(ownerRef, payload)
        // The report lives inside the microVM, and the same guarded read runs
        // there: WP-D6's `read_report_file` on the worktree root.
        return execOutcome(
          "microvm",
          result,
          await readReport(spec.worktreeRoot, spec.reportPath, spec.reportMaxBytes)
        )
      } finally {
        await adapter.release?.(ownerRef)
      }
    },
  }
}

/**
 * The bridges as they are on this device.
 *
 * Every import is dynamic, so a caller that injects its own never loads the
 * sandbox runtime, the Tauri transport or the filesystem bridge. The container
 * runtime is absent by default — see {@link AcceptanceContainerRuntime} — so a
 * device without a microVM adapter uses its OS sandbox, a Windows device has
 * no tier at all, and a device with none gets `SANDBOX_UNAVAILABLE` instead of
 * an unconfined test run.
 */
export function defaultAcceptanceSandboxHost(
  overrides: Partial<AcceptanceSandboxBridges> = {}
): AcceptanceSandboxHost {
  const bridges: AcceptanceSandboxBridges = {
    microvm: async () => {
      const { getMicrovmExec } = await import("@/lib/sandbox/microvm-bridge")
      const adapter = getMicrovmExec()
      return adapter
        ? {
            execute: (ownerRef, payload) =>
              adapter.execute(
                ownerRef,
                payload as unknown as Parameters<typeof adapter.execute>[1]
              ) as unknown as Promise<AcceptanceExecResult>,
            ...(adapter.preflight
              ? {
                  preflight: (ownerRef: string, root?: string) =>
                    adapter.preflight!(ownerRef, root),
                }
              : {}),
            ...(adapter.release
              ? { release: (ownerRef: string) => adapter.release!(ownerRef) }
              : {}),
          }
        : null
    },
    osConfined: async () => {
      const { getSandboxRuntimeAvailability } = await import("@/lib/sandbox/runtime-availability")
      return getSandboxRuntimeAvailability().os.available
    },
    platform: async () => {
      const { detectDesktopOsFamily } = await import("@/lib/platform/os")
      return detectDesktopOsFamily()
    },
    execOs: async (payload) => {
      const { sandboxSessionRuntime, HOST_FALLBACK_RUNTIME_REF } =
        await import("@/lib/sandbox/session-runtime")
      return sandboxSessionRuntime.executeSandbox(
        HOST_FALLBACK_RUNTIME_REF,
        payload as unknown as Parameters<typeof sandboxSessionRuntime.executeSandbox>[1]
      ) as unknown as AcceptanceExecResult
    },
    readReport: async (root, relPath, maxBytes) => {
      const { transport } = await import("@/lib/tauri")
      try {
        // `whole: true` is what selects report semantics: `too_large` instead
        // of a truncation, and `missing` when the command wrote nothing.
        const answer = await transport.call<ConfinedFileReadAnswer>(
          WORKSPACE_REVISION_COMMANDS.read,
          { root, relPath, maxBytes, whole: true }
        )
        if (answer.status === "ok") return { kind: "ok", content: answer.content ?? "" }
        if (answer.status === "refused") {
          return { kind: "refused", code: answer.refusal?.code ?? "READ_FAILED" }
        }
        return { kind: answer.status }
      } catch {
        // No such command on this host: the guarded workspace read, capped.
        const { readWorkspaceFile } = await import("@/lib/files/workspace-fs")
        try {
          const content = await readWorkspaceFile(root, relPath, maxBytes)
          const bytes = new TextEncoder().encode(content).byteLength
          return bytes >= maxBytes || content.endsWith("\n... (truncated)")
            ? { kind: "too_large" }
            : { kind: "ok", content }
        } catch {
          return { kind: "missing" }
        }
      }
    },
    container: null,
    ...overrides,
  }
  return createAcceptanceSandboxHost(bridges)
}

/** The `cua_sandbox_*` calls the container runtime needs, as data. */
export interface AcceptanceDockerClient {
  create(
    connectionId: string,
    image: string,
    policy: {
      networkMode?: string
      cpus?: string
      memoryMb?: number
      workspaceHostPath?: string
      workspaceContainerPath?: string
    }
  ): Promise<{ containerId: string; port: number }>
  start(
    connectionId: string,
    image: string,
    policy: Record<string, unknown>
  ): Promise<{ containerId: string; port: number }>
  inspect(connectionId: string): Promise<{
    status: string
    running: boolean
    paused: boolean
    networkMode: string
    nanoCpus: number
    memoryBytes: number
  } | null>
  exec(
    connectionId: string,
    input: {
      argv: string[]
      cwd?: string
      env?: Record<string, string>
      timeoutMs?: number
    }
  ): Promise<{
    exitCode: number
    stdout: string
    stderr: string
    durationMs: number
    timedOut: boolean
    stdoutTruncated: boolean
    stderrTruncated: boolean
  }>
  readFile(connectionId: string, path: string, maxBytes?: number): Promise<string>
  delete(connectionId: string): Promise<void>
}

export interface DockerAcceptanceRuntimeDeps {
  client: AcceptanceDockerClient
  /**
   * Whether this host's container commands can enforce the WHOLE spec — the
   * pids ceiling, `--cap-drop ALL` and `no-new-privileges` included. Today's
   * `cua_sandbox_create` policy carries network, cpu, memory and the mount
   * only, so this is false until WP-D6's runner lands, and the container tier
   * is simply not offered rather than being offered weaker than it claims.
   */
  fullSpecSupported: boolean
}

/**
 * The container tier over the Docker sandbox commands.
 *
 * Nothing is taken on trust: after the container starts, Docker's own view is
 * read back and the run is refused unless the network is really `none` and
 * the cpu and memory ceilings are really set. The container is deleted in a
 * `finally`, so a crashed run leaves no machine behind.
 */
export function createDockerAcceptanceContainerRuntime(
  deps: DockerAcceptanceRuntimeDeps
): AcceptanceContainerRuntime {
  return {
    async available() {
      return deps.fullSpecSupported
    },
    async run(spec, context) {
      const refusal = containerSpecRefusal(spec)
      if (refusal) throw new Error(refusal)
      if (!deps.fullSpecSupported) {
        throw new Error(
          "this host cannot enforce the acceptance container's pids and capability ceilings"
        )
      }
      const [mount] = spec.mounts
      const connectionId = `router-fusion-acceptance:${context.runId}:${context.logicalStepId}`
      const policy = {
        networkMode: spec.network,
        cpus: spec.cpus,
        memoryMb: spec.memoryMb,
        workspaceHostPath: mount.source,
        workspaceContainerPath: mount.target,
        pidsLimit: spec.pidsLimit,
        capDrop: spec.capDrop,
        securityOpt: spec.securityOpt,
        autoRemove: spec.autoRemove,
      }
      try {
        await deps.client.create(connectionId, spec.image, policy)
        await deps.client.start(connectionId, spec.image, policy)
        const state = await deps.client.inspect(connectionId)
        // An attestation, not a hope: a container whose network or ceilings
        // are not what was asked for runs nothing.
        if (!state || !state.running) throw new Error("the acceptance container did not start")
        if (state.networkMode !== "none") {
          throw new Error(`the acceptance container has network "${state.networkMode}"`)
        }
        if (state.nanoCpus <= 0 || state.memoryBytes <= 0) {
          throw new Error("the acceptance container has no cpu or memory ceiling")
        }
        const result = await deps.client.exec(connectionId, {
          argv: spec.argv,
          cwd: spec.workingDir,
          env: spec.env,
          timeoutMs: spec.timeoutMs,
        })
        let report: { content: string | null; truncated: boolean } = {
          content: null,
          truncated: false,
        }
        try {
          const content = await deps.client.readFile(
            connectionId,
            context.reportContainerPath,
            context.reportMaxBytes
          )
          const bytes = new TextEncoder().encode(content).byteLength
          report = { content, truncated: bytes >= context.reportMaxBytes }
        } catch {
          report = { content: null, truncated: false }
        }
        return {
          exitCode: result.timedOut ? null : result.exitCode,
          timedOut: result.timedOut,
          stdout: result.stdout,
          stderr: result.stderr,
          report,
        }
      } finally {
        await deps.client.delete(connectionId).catch(() => undefined)
      }
    },
  }
}

// ── the port ─────────────────────────────────────────────────────────────────

export type AcceptanceProfileResolver = (
  profileId: string
) => Promise<
  { ok: true; profile: ApprovedAcceptanceProfile } | { ok: false; code: string; message: string }
>

export interface DelegateAcceptancePortInput {
  runId: string
  /** Where a revision's content lives: `DelegateWorkspacePort.rootForRevision`. */
  rootForRevision: (revision: string) => Promise<string | null>
  resolveProfile: AcceptanceProfileResolver
  sandbox: AcceptanceSandboxHost
  /** The run's artifact store: the report and the logs are kept as evidence. */
  artifacts?: Pick<ArtifactStore, "put">
  newId: () => string
  /** Overrides for the resource ceilings; the profile still owns the timeout. */
  limits?: Partial<Omit<AcceptanceResourceLimits, "timeoutMs">>
  /**
   * An explicit pinned image for the container tier. It wins over
   * {@link resolveImage}; `null` states there is none.
   */
  image?: string | null
  /**
   * The project's runtime-environment image, resolved lazily and once
   * (`resolveProjectContainerImage`). Without a PINNED image
   * (`registry/repo@sha256:…`) the container tier is not offered at all: an
   * acceptance run that could be a different build each time proves nothing
   * about the revision it claims.
   */
  resolveImage?: () => Promise<string | null>
}

function refused(code: string, message: string): AcceptanceRunOutcome {
  return { kind: "refused", code, message }
}

function tail(text: string): string {
  return text.length <= ACCEPTANCE_LOG_TAIL_CHARS
    ? text
    : `… (earlier output dropped)\n${text.slice(-ACCEPTANCE_LOG_TAIL_CHARS)}`
}

/**
 * The AcceptancePort for one delegate run.
 *
 * Refusals (`kind: "refused"`) are the ones no worker can repair: no profile,
 * no approval, no sandbox, no such revision. Everything else — a failing
 * command, a missing report, a green exit over zero tests — comes back as a
 * `VerificationReport` and is judged by the package's rules.
 */
export function createDelegateAcceptancePort(input: DelegateAcceptancePortInput): AcceptancePort {
  let image: string | null | undefined
  /** Resolved once per run: an image lookup is a Host round trip. */
  const resolveImage = async (): Promise<string | null> => {
    if (image !== undefined) return image
    if (input.image !== undefined) {
      image = pinnedImageOrNull(input.image)
      return image
    }
    image = input.resolveImage
      ? pinnedImageOrNull(await input.resolveImage().catch(() => null))
      : null
    return image
  }

  return {
    async runProfile(request): Promise<AcceptanceRunOutcome> {
      const resolved = await input.resolveProfile(request.profileId)
      if (!resolved.ok) return refused(resolved.code, resolved.message)
      const profile = resolved.profile

      const worktreeRoot = await input.rootForRevision(request.revision)
      if (!worktreeRoot) {
        return refused(
          "ACCEPTANCE_REVISION_UNAVAILABLE",
          `no staged worktree holds revision ${request.revision}`
        )
      }

      // The report path is the profile's, and the profile was approved — but
      // a path is still a path: it is normalised and refused by the same rules
      // a worker's path is, so an approved `../../.ssh/id_rsa` is not a hole.
      const reportPath = normalizeDelegateHostPath(profile.report.path)
      if (!reportPath.ok) {
        return refused(
          "ACCEPTANCE_REPORT_PATH_REFUSED",
          `the profile's report path is refused: ${reportPath.code}`
        )
      }

      let availability: AcceptanceSandboxAvailability
      try {
        availability = await input.sandbox.availability()
      } catch (error) {
        return refused(
          "SANDBOX_UNAVAILABLE",
          `no sandbox tier could be established: ${error instanceof Error ? error.message : String(error)}`
        )
      }
      // The container tier needs a pinned image; without one it is not a
      // tier this device can offer, whatever the runtime says.
      const image = await resolveImage()
      const tier = selectSandboxTier({
        ...availability,
        container: availability.container && image !== null,
      })
      if (!tier) {
        return refused(
          "SANDBOX_UNAVAILABLE",
          "this device has no microVM, container or OS sandbox, and delegated code is not run unconfined"
        )
      }

      const limits = acceptanceLimitsFor(profile.timeoutMs, input.limits)
      const spec: AcceptanceRunSpec = {
        runId: request.runId,
        logicalStepId: request.logicalStepId,
        tier,
        worktreeRoot,
        cwd: profile.cwd,
        argv: [...profile.command],
        env: { ...ACCEPTANCE_ENV },
        limits,
        reportPath: reportPath.path,
        reportMaxBytes: ACCEPTANCE_REPORT_MAX_BYTES,
        image,
        signal: request.signal,
      }

      let outcome: AcceptanceCommandOutcome
      try {
        outcome = await input.sandbox.run(spec)
      } catch (error) {
        // The sandbox could not run the command at all. Not a quality result:
        // nothing about the change was learned, so no worker repairs it.
        return refused(
          "SANDBOX_RUN_FAILED",
          `the ${tier} sandbox could not run the acceptance command: ${
            error instanceof Error ? error.message : String(error)
          }`
        )
      }

      const artifactRefs: string[] = []
      if (input.artifacts) {
        const logs = [
          `$ ${spec.argv.join(" ")}`,
          `tier=${tier} cwd=${spec.cwd} exit=${outcome.exitCode ?? "none"} timed_out=${outcome.timedOut}`,
          "--- stdout",
          tail(outcome.stdout),
          "--- stderr",
          tail(outcome.stderr),
        ].join("\n")
        const stored = await input.artifacts
          .put(logs, "text/plain", `runs/${request.runId}/acceptance`)
          .catch(() => null)
        if (stored) artifactRefs.push(stored.artifactId)
        if (outcome.report.content !== null) {
          const report = await input.artifacts
            .put(
              outcome.report.content,
              profile.report.format === "junit" ? "application/xml" : "application/json",
              `runs/${request.runId}/acceptance`
            )
            .catch(() => null)
          if (report) artifactRefs.push(report.artifactId)
        }
      }

      // WP-D6: a tier that did not attest what it enforced is not a tier this
      // report may name. The port refuses rather than claiming isolation.
      if (!outcome.confinement?.networkEnforced) {
        return refused(
          "SANDBOX_CONFINEMENT_UNATTESTED",
          `the ${tier} sandbox did not attest that the acceptance run had no network`
        )
      }

      const report = buildCodeAcceptanceReport({
        reportId: input.newId(),
        revision: request.revision,
        tier,
        exitCode: outcome.exitCode,
        timedOut: outcome.timedOut,
        report: {
          format: profile.report.format as AcceptanceReportFormat,
          content: outcome.report.content,
          truncated: outcome.report.truncated,
        },
        requiredTests: profile.requiredTests,
        artifactRefs,
        parseOptions: { maxBytes: ACCEPTANCE_REPORT_MAX_BYTES },
      })
      // What was ENFORCED, from the runner's own attestation — not what the
      // policy asked for. `passed` because an unattested run never gets here,
      // so this check states the evidence rather than judging it.
      report.checks.push({
        check_id: "sandbox_confinement",
        kind: "sandbox",
        status: "passed",
        summary: confinementSummary(tier, outcome.confinement),
        executed_by: "runtime",
        artifact_refs: [],
      })
      return { kind: "report", report }
    },
  }
}

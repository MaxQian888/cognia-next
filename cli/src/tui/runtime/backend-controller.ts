/**
 * Bring an external agent backend up BEFORE the composer opens.
 *
 * Previously the process was spawned lazily on the first `send`, so every way
 * this can fail — an unsupported platform, a missing sandbox launcher, an agent
 * binary that isn't installed, a mistyped `--backend` — was discovered only
 * after the user had typed and submitted a message. Worse, nothing could be
 * known about the agent until then, so the banner showed the built-in provider
 * and model while a completely different agent was about to run.
 *
 * Connecting up front fixes both: failures arrive with the user's hands still
 * free, and the capability set comes from what the agent actually negotiated
 * rather than a guess. The connection is handed to the session factory so the
 * turn reuses this process instead of spawning a second one.
 *
 * Every host effect is injected, so the whole orchestration unit-tests without
 * spawning anything.
 */
import type { AcpCapabilities, ExternalAgentConfig } from "@/types/agent/external-agent"
import {
  createAgentFromPreset,
  getPresetConfig,
  resolvePreferredCodexExecutablePresetId,
} from "@/lib/ai/agent/external/presets"
import { getExternalAgentManager } from "@/lib/ai/agent/external/manager"

import {
  externalAgentCredentialEnv,
  resolveConnectTimeoutMs,
} from "../../agent/external-agent-session"
import {
  findSandboxLauncher,
  sandboxSupportsPlatform,
} from "../../runtime/external/sandbox-launcher"
import type { ResolvedConfig } from "../../config/schema"
import {
  canHostCogniaTools,
  externalCapabilities,
  type BackendCapabilities,
} from "./backend-capabilities"
import { buildCodexOptions } from "./backend-bridge"

/**
 * The steps a connect walks through, in order. Doubles as the failure locator.
 *
 * `command` precedes `sandbox`: whether a preset even spawns a process, and
 * whether its binary is on PATH, is a fact about the request; the sandbox is
 * only relevant once we know there is something to sandbox. Ordering it first
 * meant a preset that never spawns was rejected for a sandbox it did not need.
 */
export type BackendConnectStage = "preset" | "command" | "sandbox" | "launch"

/** Short present-tense label for the single-line progress indicator. */
export const STAGE_LABELS: Record<BackendConnectStage, string> = {
  preset: "resolving agent",
  command: "locating executable",
  sandbox: "checking sandbox",
  launch: "starting agent",
}

export type BackendConnectFailureKind =
  "unknown-backend" | "platform" | "launcher" | "command" | "handshake"

export interface BackendConnectFailure {
  kind: BackendConnectFailureKind
  /** Where it broke — the user sees this as "failed while <label>". */
  stage: BackendConnectStage
  message: string
  /** One-line remediation, when there is a concrete one. */
  hint?: string
  /** The agent binary that was missing, on a `command`-kind failure. Lets the
   * failure page resolve an install plan and offer to install it in place. */
  command?: string
}

export interface BackendConnection {
  backend: string
  /** The preset actually launched (`codex` resolves to an executable variant). */
  presetId: string
  /** The agent id this connection is registered under, so the session reuses it. */
  agentId: string
  command?: string
  capabilities: BackendCapabilities
}

export type BackendConnectResult =
  { ok: true; connection: BackendConnection } | { ok: false; failure: BackendConnectFailure }

/**
 * The slice of the shared manager a connect needs. Method names mirror
 * {@link ExternalAgentManager} exactly (see {@link defaultBackendHost}) so a
 * test double and the real manager can never diverge silently — the previous
 * `getCapabilities` name matched no manager method and was hidden by a cast.
 */
export interface BackendConnectHost {
  addAgent(config: ExternalAgentConfig): Promise<unknown>
  connect(agentId: string): Promise<void>
  getAgentCapabilities(agentId: string): AcpCapabilities | undefined
  removeAgent(agentId: string): Promise<void>
}

export interface BackendConnectDeps {
  backend: string
  config: ResolvedConfig
  agentId: string
  /** Defaults to the shared manager. Optional so a caller in the render tree
   * never has to construct one just to hand it to an injected test double. */
  host?: BackendConnectHost
  /** Progress sink for the single-line indicator. */
  onStage?: (stage: BackendConnectStage) => void
  resolvePreset?: (backend: string) => Promise<string>
  readPreset?: typeof getPresetConfig
  buildAgent?: typeof createAgentFromPreset
  platformSupported?: () => boolean
  locateLauncher?: () => string | undefined
  commandExists?: (command: string) => Promise<boolean>
}

const defaultResolvePreset = async (backend: string): Promise<string> =>
  backend === "codex" ? await resolvePreferredCodexExecutablePresetId() : backend

/**
 * Bring up `backend`, or explain precisely why it cannot come up.
 *
 * Never throws: a caller in the startup path needs a value it can render, not an
 * exception that would take the whole TUI down before the terminal is restored.
 */
export async function connectBackend(deps: BackendConnectDeps): Promise<BackendConnectResult> {
  const {
    backend,
    config,
    agentId,
    onStage,
    resolvePreset = defaultResolvePreset,
    readPreset = getPresetConfig,
    buildAgent = createAgentFromPreset,
    commandExists,
  } = deps
  const platformSupported = deps.platformSupported ?? sandboxSupportsPlatform
  const locateLauncher = deps.locateLauncher ?? findSandboxLauncher

  const fail = (failure: BackendConnectFailure): BackendConnectResult => ({ ok: false, failure })
  // Track the current step so the outer safety-net catch can pin an *unexpected*
  // throw to a step the user saw, exactly like the structured `fail(...)` paths.
  let currentStage: BackendConnectStage = "preset"
  const report = (stage: BackendConnectStage): void => {
    currentStage = stage
    onStage?.(stage)
  }

  // The whole body is guarded: this runs on the startup path, where an
  // unhandled throw would tear the TUI down before the terminal is restored.
  // The docstring's "Never throws" is the contract; this makes it true even for
  // a fault no structured branch below anticipated (a preset builder that
  // throws, a manager method that rejects off the connect path, …).
  try {
    report("preset")
    if (!readPreset(backend)) {
      return fail({
        kind: "unknown-backend",
        stage: "preset",
        message: `Unknown agent backend "${backend}".`,
        hint: "Run /backend to pick one, or start with --backend builtin.",
      })
    }
    const presetId = await resolvePreset(backend)
    const preset = readPreset(presetId)
    const command = preset?.process?.command

    // Whether this preset even spawns a process, and whether its binary exists,
    // comes BEFORE the sandbox check: a preset that never launches a process
    // must not be rejected for a sandbox it does not need.
    report("command")
    if (!command) {
      return fail({
        kind: "command",
        stage: "command",
        message: `The "${presetId}" preset declares no executable.`,
      })
    }
    if (commandExists && !(await commandExists(command))) {
      return fail({
        kind: "command",
        stage: "command",
        message: `"${command}" isn't installed or isn't on PATH.`,
        hint: `Install ${presetId}, then run /backend ${backend} to retry.`,
        command,
      })
    }

    report("sandbox")
    if (!platformSupported()) {
      return fail({
        kind: "platform",
        stage: "sandbox",
        message: `External agents can't run on ${process.platform}.`,
        hint: "They require a strict sandbox (macOS Seatbelt or Linux bubblewrap).",
      })
    }
    if (!locateLauncher()) {
      return fail({
        kind: "launcher",
        stage: "sandbox",
        message: "The sandbox launcher that isolates external agents is missing.",
        hint: "Reinstall cognia-agent, or set COGNIA_EXTERNAL_AGENT_LAUNCHER.",
      })
    }

    report("launch")
    // Built here, not at the call site: the render tree must not have to construct
    // a manager just to pass one to a test double it injected instead.
    const host = deps.host ?? defaultBackendHost()
    // Reasoning effort and extra skill roots have only this channel, and it is
    // read when the agent is registered — hence connect-time, not per turn.
    const codexOptions = buildCodexOptions(config, presetId)
    const agentConfig = buildAgent(presetId, {
      id: agentId,
      enabled: true,
      defaultPermissionMode: config.permissionMode === "auto" ? "default" : config.permissionMode,
      // Same budget the per-turn session path uses (config's `streamIdleTimeoutMs`
      // or the 60s default). Omitting it here dropped the connect onto the
      // preset's stricter 30s default and made a user-configured timeout a no-op
      // on the one path that actually does the connecting.
      timeout: resolveConnectTimeoutMs(config),
      ...(codexOptions ? { codexOptions } : {}),
    })
    if (!agentConfig) {
      return fail({
        kind: "unknown-backend",
        stage: "launch",
        message: `Could not build an agent from the "${presetId}" preset.`,
      })
    }
    if (agentConfig.process) {
      agentConfig.process = {
        ...agentConfig.process,
        cwd: config.cwd,
        env: {
          ...agentConfig.process.env,
          ...externalAgentCredentialEnv(config, presetId),
        },
      }
    }

    try {
      // Idempotent register: the agent id is stable across reconnects (a
      // `/backend` switch, a retry), and the manager throws on a duplicate id.
      // Clearing any prior registration first makes re-entry safe — without it
      // the second connect always failed with "Agent already exists".
      await host.removeAgent(agentId).catch(() => undefined)
      await host.addAgent(agentConfig)
      await host.connect(agentId)
    } catch (error) {
      // Leave nothing half-registered behind, or a retry inherits a broken agent.
      await host.removeAgent(agentId).catch(() => undefined)
      return fail({
        kind: "handshake",
        stage: "launch",
        message: error instanceof Error ? error.message : String(error),
        hint: `Check that ${presetId} is logged in, then run /backend ${backend} to retry.`,
      })
    }

    const negotiated = host.getAgentCapabilities(agentId)
    // Under the default parity contract, an agent that cannot host Cognia's tool
    // bridge is INCOMPATIBLE — not "ready with fewer tools". Every Cognia tool
    // the user can see in `/tools` would be uncallable, so fail here rather than
    // let them discover it one silent tool call at a time, after the composer
    // opened and they had already typed a request.
    if (!canHostCogniaTools(negotiated)) {
      await host.removeAgent(agentId).catch(() => undefined)
      return fail({
        kind: "handshake",
        stage: "launch",
        message: `${presetId} does not accept MCP servers, so Cognia cannot give it any of its own tools.`,
        hint: "Pick a different agent, or run /backend builtin to use Cognia's own.",
      })
    }
    return {
      ok: true,
      connection: {
        backend,
        presetId,
        agentId,
        // Guaranteed present: the `!command` case returned at the command stage.
        command,
        capabilities: externalCapabilities({
          backend,
          presetId,
          ...(negotiated ? { negotiated } : {}),
        }),
      },
    }
  } catch (error) {
    return fail({
      kind: "handshake",
      stage: currentStage,
      message: error instanceof Error ? error.message : String(error),
    })
  }
}

/**
 * The real host, backed by the shared manager.
 *
 * `healthCheckInterval: 0` for the same reason the session uses it: a
 * desktop-lived poller would keep a finished CLI process alive.
 *
 * The manager is bound to a {@link BackendConnectHost} annotation — no cast — so
 * the shared `ExternalAgentManager` has to satisfy this interface's four methods
 * by name and signature. That is exactly the check the discarded
 * `as unknown as BackendConnectHost` cast suppressed: it let `getCapabilities`
 * (a method that does not exist; the real one is `getAgentCapabilities`) compile
 * and fail only when actually called. A future rename now breaks the build here.
 */
export function defaultBackendHost(managerOverride?: BackendConnectHost): BackendConnectHost {
  const manager: BackendConnectHost =
    managerOverride ?? getExternalAgentManager({ healthCheckInterval: 0 })
  return {
    addAgent: (config) => manager.addAgent(config),
    connect: (agentId) => manager.connect(agentId),
    getAgentCapabilities: (agentId) => manager.getAgentCapabilities(agentId),
    removeAgent: (agentId) => manager.removeAgent(agentId),
  }
}

/**
 * Tear down a live external connection, killing the spawned agent process.
 *
 * The controller — not the session — owns the process it started (the session
 * runs with `ownsAgent === false` and deliberately does not remove it), so this
 * is the only path that reclaims it: on app exit, and before a `/backend` switch
 * so the old backend's process does not outlive the switch. Null-safe and
 * best-effort; a failed removal must never propagate out of a cleanup path.
 */
export async function disconnectBackend(
  connection: Pick<BackendConnection, "agentId"> | null | undefined,
  host: Pick<BackendConnectHost, "removeAgent"> = defaultBackendHost()
): Promise<void> {
  if (!connection) return
  await host.removeAgent(connection.agentId).catch(() => undefined)
}

/** The line shown under the banner while a connect is in flight. */
export function connectProgressLine(backend: string, stage: BackendConnectStage): string {
  return `starting ${backend} … ${STAGE_LABELS[stage]}`
}

/** "failed while checking sandbox" — pins the failure to a step the user saw. */
export function connectFailureHeadline(backend: string, failure: BackendConnectFailure): string {
  return `Couldn't start ${backend} — failed while ${STAGE_LABELS[failure.stage]}.`
}

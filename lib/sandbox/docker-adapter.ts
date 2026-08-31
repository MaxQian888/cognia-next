/**
 * The Docker provider adapter (ADR-0020 remote-target).
 *
 * Implements {@link SandboxProviderAdapter} against the `cua_sandbox_*` Tauri
 * commands. Every method here is reachable only through
 * `runSandboxOperation`, which checks the connection's capability matrix and
 * its lifecycle state first, so nothing in this file re-checks either.
 *
 * Two things this adapter refuses to fake:
 *
 *   * `suspend` is `docker pause`, never `docker stop`. Pause SIGSTOPs the
 *     processes and keeps memory resident, so the desktop session is still
 *     there on resume. A stopped container has lost it. Implementing suspend
 *     with stop would report a paused machine that had silently rebooted.
 *   * `delete` is `docker rm`, never `docker stop`. The previous
 *     implementation called stop for both, which only looked correct because
 *     containers were created with `--rm`.
 */

import type {
  SandboxClient,
  SandboxContainerState,
  SandboxPolicyInput,
} from "@/lib/automation/sandbox-client"
import { MicrovmAdapterError } from "@cognia/plugin-sdk/api/sandbox"
import type {
  DockerSandboxConfig,
  SandboxConnectionRow,
  SandboxLifecycleOperation,
  SandboxLifecycleState,
} from "@/types/sandbox"
import { attestDockerPolicy, containerPathFor } from "./docker-policy-attestation"
import {
  SandboxCapabilityError,
  type SandboxExecRequest,
  type SandboxExecResult,
  type SandboxHealthReport,
  type SandboxOperationContext,
  type SandboxProviderAdapter,
} from "./lifecycle-contract"

/** Side channel for values a lifecycle call discovers, e.g. the mapped port. */
export interface DockerAdapterOutcome {
  containerId?: string
  port?: number
  health?: boolean
  /** Docker's own state, when the call read it. */
  containerState?: SandboxContainerState | null
}

/**
 * Map Docker's `.State.Status` onto the provider-neutral lifecycle vocabulary.
 *
 * `paused` becomes `suspended` rather than `stopped`. Those are different
 * machines to a user, and the whole point of using pause for suspend is that
 * the session survives. `created` becomes `stopped` because the container
 * exists and has run nothing, which is exactly what stopped means here.
 */
export function lifecycleStateFromDocker(status: string): SandboxLifecycleState {
  switch (status) {
    case "running":
      return "running"
    case "paused":
      return "suspended"
    case "restarting":
      return "starting"
    case "removing":
      return "deleting"
    case "created":
    case "exited":
      return "stopped"
    case "dead":
      return "error"
    default:
      // An unrecognised status is not evidence of anything. Reporting it as
      // stopped or running would be a guess with even odds of becoming the
      // reason a later operation is refused for the wrong cause.
      return "error"
  }
}

/** The container policy this row was created with, in client-input shape. */
export function policyInputFromConfig(config: DockerSandboxConfig): SandboxPolicyInput | undefined {
  const input: SandboxPolicyInput = {}
  if (config.networkMode) input.networkMode = config.networkMode
  if (config.cpus) input.cpus = config.cpus
  if (typeof config.memoryMb === "number") input.memoryMb = config.memoryMb
  if (config.workspaceMount) {
    input.workspaceHostPath = config.workspaceMount.hostPath
    input.workspaceContainerPath = config.workspaceMount.containerPath
  }
  return Object.keys(input).length > 0 ? input : undefined
}

/**
 * Narrow a row to its Docker config, or refuse.
 *
 * A row whose `provider` and `config.provider` disagree is not merely odd. Its
 * `config` carries no image, so starting it would ask Docker to run nothing at
 * all.
 */
export function requireDockerConfig(
  row: SandboxConnectionRow,
  operation: SandboxLifecycleOperation
): DockerSandboxConfig {
  if (row.config.provider !== "docker") {
    throw new SandboxCapabilityError({
      code: "not-implemented",
      operation,
      provider: row.provider,
      driver: row.driver,
      message: `Connection "${row.id}" is a Docker row whose config describes ${row.config.provider}.`,
    })
  }
  return row.config
}

export function buildDockerSandboxAdapter(
  row: SandboxConnectionRow,
  client: SandboxClient,
  outcome: DockerAdapterOutcome,
  operation: SandboxLifecycleOperation
): SandboxProviderAdapter {
  const config = requireDockerConfig(row, operation)
  const policy = policyInputFromConfig(config)
  const image = config.image

  const record = (placement: { containerId: string; port: number }) => {
    outcome.containerId = placement.containerId
    outcome.port = placement.port
  }

  return {
    provider: row.provider,
    driver: row.driver,

    create: async (ctx) => {
      record(await client.create(ctx.connectionId, image, policy))
    },

    start: async (ctx) => {
      record(await client.start(ctx.connectionId, image, policy))
    },

    suspend: async (ctx) => client.suspend(ctx.connectionId),

    resume: async (ctx) => {
      record(await client.resume(ctx.connectionId))
    },

    stop: async (ctx) => client.stop(ctx.connectionId),

    delete: async (ctx) => client.delete(ctx.connectionId),

    health: async (ctx): Promise<SandboxHealthReport> => {
      // Two questions with different answers. `inspect` says what Docker
      // believes. `health` proves the exec channel every workspace operation
      // rides is actually usable. A container Docker calls running whose exec
      // channel is dead is not a healthy machine.
      const state = await client.inspect(ctx.connectionId)
      outcome.containerState = state
      if (!state) {
        outcome.health = false
        return { reachable: false, state: "uninitialized", error: "No container exists yet." }
      }
      const mapped = lifecycleStateFromDocker(state.status)
      if (!state.running || state.paused) {
        outcome.health = false
        return { reachable: false, state: mapped }
      }
      const reachable = await client.health(ctx.connectionId)
      outcome.health = reachable
      return {
        reachable,
        state: mapped,
        ...(reachable
          ? {}
          : { error: "The container is running but does not answer `docker exec`." }),
      }
    },

    workspaceRead: async (ctx, path) => {
      // A host path means nothing inside a container. Reading it verbatim
      // would either miss or, worse, hit an unrelated file that happens to
      // share the path. Translate through the mount or refuse.
      const inContainer = config.workspaceMount ? containerPathFor(config, path) : path
      if (inContainer === null) {
        throw new MicrovmAdapterError(
          "workspace-boundary",
          `"${path}" is outside the directory mounted into this machine, so it cannot be read from inside it.`
        )
      }
      return client.readFile(ctx.connectionId, inContainer)
    },

    workspaceExec: async (
      ctx: SandboxOperationContext,
      request: SandboxExecRequest
    ): Promise<SandboxExecResult> => {
      // Docker froze this container's network mode and its cpu/memory ceiling
      // at create time, and `docker exec` cannot tighten any of them for one
      // command. A request asking for more confinement than the machine has is
      // refused rather than run, because running it would execute under weaker
      // isolation than the caller believes it obtained.
      if (request.policy) {
        const attestation = attestDockerPolicy(config, request.policy)
        if (!attestation.attested) {
          throw new MicrovmAdapterError("policy-not-attested", attestation.reason)
        }
      }
      const result = await client.exec(ctx.connectionId, {
        argv: request.argv,
        cwd: request.cwd,
        env: request.env,
        stdin: request.stdin,
        timeoutMs: request.timeoutMs,
      })
      return {
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        durationMs: result.durationMs,
        timedOut: result.timedOut,
        stdoutTruncated: result.stdoutTruncated,
        stderrTruncated: result.stderrTruncated,
      }
    },
  }
}

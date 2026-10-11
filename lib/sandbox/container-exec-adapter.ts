/**
 * The `container` shell tier's adapter (ADR-0224 A8).
 *
 * On an always-on Host a built-in turn's `sandbox_bash`, `edit`, `write` and
 * `text_editor` must not run on the Host. This adapter sends each command to
 * the Host's sandbox pool through the service-only `environment_task_shell_exec`
 * command, which runs it in a retained container of the session's runtime
 * environment, as that environment's user, in the session's workspace under
 * the same path. When the session's generation retires, the runtimes it used
 * are released with `environment_task_shell_release`.
 *
 * It implements the microVM adapter seam (`preflight` / `execute` / `release`)
 * so `SandboxSessionRuntime` treats both tiers alike: a preflight claims the
 * placement before the bind succeeds, and a ref the adapter does not know
 * refuses rather than running anywhere else.
 *
 * Only a headless Host registers one ({@link getContainerExec}). The service
 * commands exist on its local companion; the desktop has neither the pool nor
 * a service token, so there the tier's bind refuses.
 */

import {
  SandboxRuntimeError,
  type MicrovmExecAdapter,
  type MicrovmExecPayload,
  type MicrovmResult,
  type SandboxRuntimeRef,
} from "@cognia/plugin-sdk/api/sandbox"
import { isHeadlessHost } from "@/lib/platform/detect"
import type { SandboxPlacement } from "@/types/sandbox/environment-spec"

/** The default command timeout when a tool call names none, in seconds. */
export const CONTAINER_DEFAULT_TIMEOUT_SECONDS = 120

/** The wire answer of `environment_task_shell_exec`. */
export interface TaskShellResultWire {
  exitCode: number | null
  stdout: string
  stderr: string
  stdoutTruncated: boolean
  stderrTruncated: boolean
  timedOut: boolean
  durationMs: number
  provider: string
  containerId: string
  tier: string
}

export interface ContainerExecDeps {
  /** A service-plane call on the Host's local companion. */
  call<T>(command: string, args: Record<string, unknown>): Promise<T>
  /** The session's runtime environment placement, or a refusal. */
  resolvePlacement(input: { sessionId: string; workspaceRoot: string }): Promise<SandboxPlacement>
}

interface Binding {
  placement: SandboxPlacement
  workspaceRoot: string
  owner: string
  /** Runtimes this generation ran in, by provider, for its release. */
  runtimes: Map<string, Set<string>>
}

/** A killed command with no status of its own reports what `timeout(1)` does. */
const TIMED_OUT_EXIT = 124

function egressOff(placement: SandboxPlacement): boolean {
  const egress = (placement.spec as { egress?: { tier?: unknown } } | undefined)?.egress
  return egress?.tier === "off"
}

export function createContainerExecAdapter(deps: ContainerExecDeps): MicrovmExecAdapter {
  const bindings = new Map<SandboxRuntimeRef, Binding>()

  const release = async (ref: SandboxRuntimeRef): Promise<void> => {
    const binding = bindings.get(ref)
    bindings.delete(ref)
    if (!binding) return
    const failures: unknown[] = []
    for (const [provider, ids] of binding.runtimes) {
      if (ids.size === 0) continue
      try {
        await deps.call("environment_task_shell_release", {
          provider,
          containerIds: [...ids],
        })
      } catch (error) {
        failures.push(error)
      }
    }
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) {
      throw new AggregateError(failures, "Some task shell runtimes could not be released.")
    }
  }

  return {
    async preflight(ref, workspaceRoot, ownerGroup) {
      if (!workspaceRoot) {
        throw new SandboxRuntimeError(
          "placement-unavailable",
          "The container shell tier runs in the session's workspace, and this session has none."
        )
      }
      if (!ownerGroup) {
        throw new SandboxRuntimeError(
          "placement-unavailable",
          "The container shell tier needs the session it runs for."
        )
      }
      const placement = await deps.resolvePlacement({ sessionId: ownerGroup, workspaceRoot })
      bindings.set(ref, {
        placement,
        workspaceRoot,
        owner: `session:${ownerGroup}`,
        runtimes: new Map(),
      })
    },

    async execute(ref, payload: MicrovmExecPayload): Promise<MicrovmResult> {
      const binding = bindings.get(ref)
      if (!binding) {
        throw new SandboxRuntimeError(
          "runtime-released",
          "The container placement for this session is gone; the command was not run."
        )
      }
      const { command } = payload
      const seconds = command.timeout > 0 ? command.timeout : CONTAINER_DEFAULT_TIMEOUT_SECONDS
      const result = await deps.call<TaskShellResultWire>("environment_task_shell_exec", {
        placement: binding.placement,
        owner: binding.owner,
        workspaceRoot: binding.workspaceRoot,
        cwd: command.cwd || binding.workspaceRoot,
        argv: command.argv,
        env: command.env ?? {},
        ...(command.stdin != null ? { stdin: command.stdin } : {}),
        timeoutMs: Math.max(1, Math.round(seconds * 1000)),
      })
      // Recorded even for a generation released meanwhile: the release below
      // ran before this answer, so a runtime first seen now is released now.
      const runtimes = binding.runtimes.get(result.provider) ?? new Set<string>()
      runtimes.add(result.containerId)
      binding.runtimes.set(result.provider, runtimes)
      if (!bindings.has(ref)) {
        void deps
          .call("environment_task_shell_release", {
            provider: result.provider,
            containerIds: [result.containerId],
          })
          .catch(() => undefined)
      }
      return {
        exit_code: result.exitCode ?? (result.timedOut ? TIMED_OUT_EXIT : -1),
        stdout: result.stdout,
        stderr: result.stderr,
        duration: result.durationMs,
        timed_out: result.timedOut,
        ...(result.stdoutTruncated ? { stdout_truncated: true } : {}),
        ...(result.stderrTruncated ? { stderr_truncated: true } : {}),
        confinement: {
          // Only the environment's own egress tier is attested: the container
          // has no network at all when it is `off`, and otherwise reaches what
          // the environment's egress allows, whatever this call asked for.
          networkEnforced: egressOff(binding.placement),
          backend: `container:${result.tier}`,
          platform: "linux",
        },
      }
    },

    release,

    async dispose() {
      const refs = [...bindings.keys()]
      await Promise.allSettled(refs.map((ref) => release(ref)))
    },
  }
}

let containerExec: MicrovmExecAdapter | null | undefined

/**
 * The container adapter on a headless Host, else null. Created on first use;
 * the transport and the placement resolver load only when a command runs.
 */
export function getContainerExec(): MicrovmExecAdapter | null {
  if (containerExec !== undefined) return containerExec
  containerExec = isHeadlessHost()
    ? createContainerExecAdapter({
        call: async (command, args) => {
          const { transport } = await import("@/lib/tauri")
          return transport.call(command, args)
        },
        resolvePlacement: async (input) => {
          const { defaultTaskShellPlacementSources, resolveTaskShellPlacement } =
            await import("./task-shell-placement")
          return resolveTaskShellPlacement(input, defaultTaskShellPlacementSources())
        },
      })
    : null
  return containerExec
}

/** Test-only: install an adapter, or `undefined` to start over. */
export function __setContainerExecForTesting(adapter: MicrovmExecAdapter | null | undefined): void {
  containerExec = adapter
}

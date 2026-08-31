"use client"

/**
 * Open a real terminal inside a Docker machine.
 *
 * ADR-0160 made containers persistent machines with a lifecycle, and proved
 * `docker exec` carries shell and file work into them. What was still missing
 * was a way to stand inside one: `cua_sandbox_exec` runs a single command and
 * returns its output, which is not a terminal, and a loop over one-shot execs
 * pretending to be one would have no job control, no signals, no pty and no
 * resize.
 *
 * So this opens no new channel at all. `docker exec -it` is a program that
 * wants a pty, the terminal host already spawns programs into ptys, and an
 * ad-hoc spawn request is the shape for a shell that has no saved profile. The
 * whole terminal subsystem follows: tabs, replay, search, history, close
 * confirmation, and the plugin lifecycle hooks.
 *
 * Two constraints are structural rather than incidental.
 *
 * The container id comes from `docker inspect` through
 * `sandboxClient.inspect`, never from re-deriving the deterministic name.
 * ADR-0160 made inspect the single source of truth precisely because an
 * in-process map recorded what we asked for rather than what Docker did.
 *
 * And this is offered only where the terminal host and the machines are the
 * same computer. `cua_sandbox_*` is `target: "client"`, so the machines always
 * belong to the renderer's own machine, while the terminal follows whichever
 * host the transport routes to. On a phone, or on a desktop driving a remote
 * host, running the exec would open a shell on the wrong box, so it is refused
 * with that reason instead.
 */

import { sandboxClient } from "@/lib/automation/sandbox-client"
import { selectTerminalTransport } from "@/lib/terminal/pick-transport"
import { spawnFromDock, type TerminalStoreLike } from "@/lib/terminal/spawn-orchestrator"

/** Opening geometry. The host re-fits on attach. */
const SHELL_ROWS = 28
const SHELL_COLS = 100

/**
 * `bash` when the image has it, `sh` when it does not.
 *
 * Resolved inside the container rather than guessed outside it, because the
 * image decides and a distroless or alpine base has no bash at all. `command
 * -v` is the POSIX test and is available in every `/bin/sh` worth the name.
 * `exec` replaces the shell, so the pty's foreground process is the
 * interactive shell itself rather than a wrapper that swallows signals.
 */
export const CONTAINER_SHELL_SCRIPT = "command -v bash >/dev/null 2>&1 && exec bash || exec sh"

/** The argv `docker exec` is given. Exported so a test can pin it whole. */
export function machineShellArgv(containerId: string): string[] {
  return ["exec", "-it", containerId, "/bin/sh", "-lc", CONTAINER_SHELL_SCRIPT]
}

export type MachineShellOutcome =
  | { kind: "opened"; sessionId: string }
  /** The machine exists but is not in a state that can accept an exec. */
  | { kind: "not-running"; state: "paused" | "absent" | "stopped" }
  /**
   * The terminal would land on a different computer than the machine lives on.
   * Not a failure of the machine, and not fixable by retrying.
   */
  | { kind: "wrong-host" }
  | { kind: "error"; message: string }

export interface OpenMachineShellInput {
  connectionId: string
  /** Tab label. The machine's name, so the tab says which box it is. */
  name: string
  store: TerminalStoreLike
  /** Test seams. */
  inspect?: typeof sandboxClient.inspect
  spawn?: typeof spawnFromDock
  transport?: typeof selectTerminalTransport
}

export async function openMachineShell(input: OpenMachineShellInput): Promise<MachineShellOutcome> {
  const transport = (input.transport ?? selectTerminalTransport)()
  if (transport !== "tauri-channel") return { kind: "wrong-host" }

  let container: Awaited<ReturnType<typeof sandboxClient.inspect>>
  try {
    container = await (input.inspect ?? sandboxClient.inspect)(input.connectionId)
  } catch (error) {
    return { kind: "error", message: error instanceof Error ? error.message : String(error) }
  }

  if (!container) return { kind: "not-running", state: "absent" }
  /**
   * Docker reports a paused container as still running, so `paused` is checked
   * first. The two need different remedies: a paused machine resumes with its
   * memory intact, a stopped one has to be started and has lost it.
   */
  if (container.paused) return { kind: "not-running", state: "paused" }
  if (!container.running) return { kind: "not-running", state: "stopped" }

  const outcome = await (input.spawn ?? spawnFromDock)({
    req: {
      shell: "docker",
      args: machineShellArgv(container.containerId),
      rows: SHELL_ROWS,
      cols: SHELL_COLS,
    },
    store: input.store,
    title: input.name,
  })

  if (outcome.kind === "denied") {
    return { kind: "error", message: "the spawn was denied by a plugin hook" }
  }
  if (outcome.kind === "error") return outcome
  return { kind: "opened", sessionId: outcome.sessionId }
}

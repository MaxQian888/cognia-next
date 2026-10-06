/**
 * The app's implementation of the `AgentProcessHost` port (ADR-0217).
 *
 * Integration packages reach child processes only through
 * `@cognia/agent-contracts/host`. Every Cognia host already speaks one process
 * plane — `spawn_external_agent` / `send_to_external_agent` /
 * `kill_external_agent` plus the `external-agent://*` events — whether it is
 * the Tauri bridge, a paired Host over the companion transport, the headless
 * brain, or the CLI's Node backend. This module maps the typed port onto that
 * plane once, so no integration knows command names or channel strings.
 *
 * Placement, the spawn allowlist, the sandbox and audit stay where they are:
 * in `agent-transport` (placement) and in the host behind the plane.
 */

import type {
  AgentProcessExitEvent,
  AgentProcessHost,
  AgentProcessOutputEvent,
  Unsubscribe,
} from "@cognia/agent-contracts/host"
import {
  agentInvoke,
  agentListen,
  runsExternalAgentProcessesLocally,
  supportsExternalAgents,
} from "../agent-transport"

/** A string-command process plane: `agentInvoke`/`agentListen`, or the CLI backend's. */
export interface ProcessPlane {
  invoke<T>(name: string, args: Record<string, unknown>): Promise<T>
  listen<T>(event: string, callback: (payload: T) => void): Promise<() => void>
}

interface PlaneOutputPayload {
  agentId: string
  data: string
}

interface PlaneExitPayload {
  agentId: string
  code: number
  signal?: string | null
}

const toOutput = (payload: PlaneOutputPayload): AgentProcessOutputEvent => ({
  processId: payload.agentId,
  data: payload.data,
})

/** Adapt any string-command process plane to the typed port. */
export function createProcessPlaneHost(
  plane: ProcessPlane,
  isAvailable: () => boolean
): AgentProcessHost {
  const output =
    (channel: string) =>
    (listener: (event: AgentProcessOutputEvent) => void): Promise<Unsubscribe> =>
      plane.listen<PlaneOutputPayload>(channel, (payload) => listener(toOutput(payload)))
  return {
    get available() {
      return isAvailable()
    },
    spawn: async (spec) => {
      const registered = await plane.invoke<unknown>("spawn_external_agent", {
        config: {
          id: spec.id,
          command: spec.command,
          ...(spec.args ? { args: spec.args } : {}),
          ...(spec.cwd !== undefined ? { cwd: spec.cwd } : {}),
          ...(spec.env ? { env: spec.env } : {}),
          ...(spec.framing ? { framing: spec.framing } : {}),
        },
      })
      return typeof registered === "string" && registered.length > 0 ? registered : spec.id
    },
    send: async (processId, message) => {
      await plane.invoke<unknown>("send_to_external_agent", { agentId: processId, message })
    },
    kill: async (processId) => {
      await plane.invoke<unknown>("kill_external_agent", { agentId: processId })
    },
    commandExists: async (command) =>
      (await plane.invoke<unknown>("check_command_exists", { command })) === true,
    onStdoutLine: output("external-agent://stdout"),
    onStdoutRaw: output("external-agent://stdout-raw"),
    onStderr: output("external-agent://stderr"),
    onExit: (listener: (event: AgentProcessExitEvent) => void) =>
      plane.listen<PlaneExitPayload>("external-agent://exit", (payload) =>
        listener({
          processId: payload.agentId,
          code: payload.code,
          ...(payload.signal !== undefined ? { signal: payload.signal } : {}),
        })
      ),
  }
}

const agentTransportPlane: ProcessPlane = {
  invoke: (name, args) => agentInvoke(name, args),
  listen: (event, callback) => agentListen(event, callback),
}

/**
 * The process host every app-side integration gets.
 *
 * `any` can reach a paired Host's process table over the companion plane;
 * `local` requires a process table in this shell (a runtime whose install and
 * facts are local-only commands, such as managed DeepSeek Harness).
 */
export function createAgentTransportProcessHost(reach: "any" | "local" = "any"): AgentProcessHost {
  return createProcessPlaneHost(
    agentTransportPlane,
    reach === "local" ? runsExternalAgentProcessesLocally : supportsExternalAgents
  )
}

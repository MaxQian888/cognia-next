"use client"

/**
 * Desktop-side counterpart of the Rust `cli_bridge::renderer_bridge`.
 *
 * The CLI hits a renderer-backed bridge route (`/api/v1/dev/twin/context`,
 * `/api/v1/dev/teams/*`); the Rust handler emits one unified
 * `cli-bridge://renderer-request` event with `{ requestId, command,
 * payload }`. This module dispatches by command name, runs the matching
 * renderer operation (Dexie / Zustand / twin runtime), and ships the result
 * back via the `cli_bridge_renderer_response` Tauri command.
 *
 * Modeled after `lib/companion/desktop-write-source.ts` — same install
 * guard, same bridge-injection pattern for tests. Handlers are
 * lazy-imported so mounting the listener costs nothing until the first
 * request arrives.
 */

import { listen } from "@tauri-apps/api/event"
import { invoke } from "@tauri-apps/api/core"

const REQUEST_EVENT = "cli-bridge://renderer-request"
const RESPONSE_COMMAND = "cli_bridge_renderer_response"

interface RendererRequestEvent {
  requestId: string
  command: string
  payload: Record<string, unknown>
}

/** Tiny Tauri shape so the file type-checks in pure-web tests too. */
interface TauriBridge {
  listen<T>(event: string, handler: (e: { payload: T }) => void): Promise<() => void>
  invoke(name: string, args: Record<string, unknown>): Promise<unknown>
}

let installed = false

export interface InstallOptions {
  bridge?: TauriBridge
  forceReinstall?: boolean
}

export async function installCliRendererRequestSource(
  opts: InstallOptions = {}
): Promise<() => void> {
  if (installed && !opts.forceReinstall) return () => {}
  installed = true

  let bridge: TauriBridge
  if (opts.bridge) {
    bridge = opts.bridge
  } else {
    try {
      bridge = { listen, invoke }
    } catch {
      installed = false
      return () => {}
    }
  }

  const unlisten = await bridge.listen<RendererRequestEvent>(REQUEST_EVENT, (event) => {
    void respond(event.payload, bridge)
  })

  return () => {
    installed = false
    unlisten()
  }
}

async function respond(req: RendererRequestEvent, bridge: TauriBridge): Promise<void> {
  const { requestId, command, payload } = req
  try {
    const result = await dispatchCommand(command, payload ?? {})
    await bridge.invoke(RESPONSE_COMMAND, { response: { requestId, result, error: null } })
  } catch (err: unknown) {
    await bridge.invoke(RESPONSE_COMMAND, {
      response: {
        requestId,
        result: null,
        error: err instanceof Error ? err.message : String(err),
      },
    })
  }
}

/** Exposed for tests — production callers go through the listener above. */
export async function dispatchCommand(
  command: string,
  payload: Record<string, unknown>
): Promise<unknown> {
  switch (command) {
    case "twin_context_get": {
      const { twinContextGet } = await import("./handlers/twin-context")
      return twinContextGet(payload)
    }
    case "agent_team_list": {
      const { agentTeamList } = await import("./handlers/agent-team")
      return agentTeamList()
    }
    case "agent_team_run": {
      const { agentTeamRun } = await import("./handlers/agent-team")
      return agentTeamRun(payload)
    }
    case "agent_team_run_status": {
      const { agentTeamRunStatus } = await import("./handlers/agent-team")
      return agentTeamRunStatus(payload)
    }
    default:
      throw new Error(`unknown cli-bridge renderer command: ${command}`)
  }
}

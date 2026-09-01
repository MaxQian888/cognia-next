"use client"

/**
 * Open a serial port as a dock session.
 *
 * The serial sibling of `lib/terminal/ssh-connect.ts`, and deliberately the
 * same three lines of bookkeeping: register the live handle, register the row,
 * wire the store. Everything the dock does with a session after that (tabs,
 * search, splits, the AI-shell context reader) is transport-agnostic and needs
 * nothing here.
 *
 * Unlike SSH there is no remote path. `terminal_open_serial` is
 * `target: "client"`, so a paired phone cannot open a port on someone's desk,
 * and this refuses on any shell that is not the one holding the hardware
 * rather than sending a call that would come back 403.
 */

import { getPluginEventHooks } from "@/lib/plugin/messaging/hooks-system"

import { registerLiveSession } from "./session-registry"
import { SerialTerminalSession } from "./serial-session"
import type { SerialConfig } from "./serial/types"
import { wireSessionToStore, type TerminalStoreLike } from "./spawn-orchestrator"
import { selectTerminalTransportChain } from "./pick-transport"

export type SerialConnectOutcome =
  | { kind: "connected"; sessionId: string }
  | { kind: "error"; message: string }
  | { kind: "unsupported" }

export async function connectSerialFromDock(input: {
  config: SerialConfig
  projectId?: string
  store: TerminalStoreLike
  /** Test seam. */
  open?: typeof SerialTerminalSession.open
  /** Test seam. Defaults to the live transport chain. */
  transportChain?: typeof selectTerminalTransportChain
}): Promise<SerialConnectOutcome> {
  // The port is a device node on THIS machine. A companion shell talking to a
  // remote host has no such node, and the host's own ports are not the user's
  // to open from a phone, so the honest answer is "not here" rather than an
  // error that reads like the device is broken.
  const chain = (input.transportChain ?? selectTerminalTransportChain)()
  if (chain[0] !== "tauri-channel") return { kind: "unsupported" }

  let session: SerialTerminalSession
  try {
    session = await (input.open ?? SerialTerminalSession.open)(
      input.config,
      input.projectId ?? null
    )
  } catch (error) {
    return {
      kind: "error",
      message: error instanceof Error ? error.message : String(error),
    }
  }

  const hooks = getPluginEventHooks()
  registerLiveSession(session)
  input.store.registerSession(session.info, { title: input.config.port })
  wireSessionToStore(session, input.store, hooks)
  hooks.dispatchTerminalLifecycle({
    kind: "spawned",
    sessionId: session.info.id,
    projectId: session.info.projectId,
    extensionId: null,
  })
  return { kind: "connected", sessionId: session.info.id }
}

"use client"

/**
 * Read and write the terminal host's own settings, from whichever shell.
 *
 * These settings are NOT part of `AppSettings`. They live in a file next to
 * the terminal host process (`terminal-host/settings.json`) and govern the
 * host itself: its session and replay limits, whether it starts at login, and
 * the remote-access switch every `/ws/terminal` connection is checked against.
 * `AppSettings.terminal.host` is a mirror of them, written alongside each
 * successful change so the card has something to render before the host
 * answers.
 *
 * The desktop drove them through the local `terminal_host_service` command,
 * which no remote client can reach — and the card's write was wrapped in
 * `isTauri()`, so on web every one of these switches wrote the mirror and
 * nothing else. The remote-access switch was the worst of them: it is the one
 * a user goes looking for when a browser terminal will not connect, and
 * flipping it did nothing at all.
 *
 * Two command names because they are two authorities: the local command also
 * owns `provision` and the login-service registration and stays local, while
 * `terminal_host_configure` is capability-gated on `host.admin` — which owner
 * devices hold and chat-only paired devices do not.
 */

import { transport } from "@/lib/tauri"

import { selectTerminalTransportChain } from "./pick-transport"

export interface TerminalHostSettingsWire {
  allowRemoteAccess: boolean
  startAtLogin: boolean
  diagnostics: boolean
  maxSessions: number
  maxRemoteSessionsPerDevice: number
  replayBytesPerSession: number
  totalReplayBytes: number
}

export interface TerminalHostStatusWire {
  running: boolean
  endpoint: string
  settings: TerminalHostSettingsWire
}

/** True when some host — local or remote — can answer at all. */
export function terminalHostReachable(): boolean {
  return selectTerminalTransportChain().length > 0
}

function isLocalHost(): boolean {
  return selectTerminalTransportChain()[0] === "tauri-channel"
}

/**
 * The host's settings as it actually has them.
 *
 * Returns `null` when there is no host to ask (web standalone) or it cannot be
 * reached — callers fall back to the mirror rather than rendering nothing,
 * which is the pre-existing behaviour, but they must not present a fallback as
 * the host's answer.
 */
export async function readTerminalHostSettings(
  call: typeof transport.call = transport.call.bind(transport)
): Promise<TerminalHostSettingsWire | null> {
  if (!terminalHostReachable()) return null
  try {
    const status = isLocalHost()
      ? await call<TerminalHostStatusWire>("terminal_host_service", {
          action: { kind: "status" },
        })
      : await call<TerminalHostStatusWire>("terminal_host_status", {})
    return status?.settings ?? null
  } catch {
    return null
  }
}

/**
 * Apply settings to the host. Throws when the host refuses or is unreachable,
 * so the caller can keep the mirror untouched rather than recording a change
 * that never happened.
 */
export async function writeTerminalHostSettings(
  settings: TerminalHostSettingsWire,
  call: typeof transport.call = transport.call.bind(transport)
): Promise<void> {
  if (!terminalHostReachable()) {
    throw new Error("no terminal host is reachable from this shell")
  }
  if (isLocalHost()) {
    await call("terminal_host_service", { action: { kind: "configure", settings } })
    return
  }
  await call("terminal_host_configure", { settings })
}

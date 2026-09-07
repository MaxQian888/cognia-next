"use client"

/**
 * Tunnel resolver (Wave 1.6) — desktop-side launcher controls + URL
 * resolution helpers. Talks to the Rust `companion_tunnel_*` Tauri
 * commands.
 */

import { isTauri } from "@/lib/platform/detect"

/**
 * Mirrors Rust `companion_api::server::DEFAULT_PORT`: 27890, outside the
 * 789x Clash mixed/SOCKS range so it cannot collide with a local proxy.
 */
export const COMPANION_SERVER_DEFAULT_PORT = 27890

/**
 * The origin the companion tunnel exposes: this Host's HTTPS listener.
 *
 * Lives beside `startTunnel` / `probeTunnel` rather than in a settings block,
 * because "is this tunnel pointed at the Host" is a connectivity fact, and
 * every surface that has to answer it would otherwise import a React component
 * to read one string.
 */
export const COMPANION_TUNNEL_LOCAL_URL = `https://127.0.0.1:${COMPANION_SERVER_DEFAULT_PORT}`

export interface TunnelInfo {
  publicUrl: string
  localUrl: string
}

export interface TunnelConfigSummary {
  mode: "quick" | "named"
  hostname?: string
  hasToken: boolean
}

export interface TauriInvoker {
  invoke<T = unknown>(cmd: string, args?: Record<string, unknown>): Promise<T>
}

const tauriInvoker: () => Promise<TauriInvoker | null> = async () => {
  try {
    if (!isTauri()) return null
    const moduleId = "@tauri-apps/api/core"
    const mod = (await import(/* webpackIgnore: true */ moduleId)) as TauriInvoker
    return mod
  } catch {
    return null
  }
}

export type StartOutcome =
  | { kind: "started"; info: TunnelInfo }
  | { kind: "not_installed" }
  /**
   * The one cloudflared child is already exposing a different local origin
   * (the companion listener vs. the connectors' webhook receiver). Start
   * again with `replace: true` to take it over, knowingly.
   */
  | { kind: "busy"; current: TunnelInfo }
  | { kind: "unsupported" }
  | { kind: "error"; message: string }

/** Mirror of `TunnelError::Busy`'s message in `companion_api/tunnel.rs`. */
const BUSY_RE = /^tunnel_busy: already exposing (\S+) at (\S+)$/

/** Read the origin conflict out of a `companion_tunnel_start` failure. */
export function parseTunnelBusy(message: string): TunnelInfo | null {
  const match = BUSY_RE.exec(message.trim())
  return match ? { localUrl: match[1], publicUrl: match[2] } : null
}

export interface StartTunnelOptions {
  /** Take over a tunnel that is exposing another origin. */
  replace?: boolean
}

export async function startTunnel(
  localUrl: string,
  loader: () => Promise<TauriInvoker | null> = tauriInvoker,
  options: StartTunnelOptions = {}
): Promise<StartOutcome> {
  const invoker = await loader()
  if (!invoker) return { kind: "unsupported" }
  try {
    const info = await invoker.invoke<TunnelInfo>("companion_tunnel_start", {
      localUrl,
      replace: options.replace === true,
    })
    return { kind: "started", info }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    const busy = parseTunnelBusy(msg)
    if (busy) return { kind: "busy", current: busy }
    if (/not.installed|cloudflared.*not.found|enoent/i.test(msg)) {
      return { kind: "not_installed" }
    }
    return { kind: "error", message: msg }
  }
}

/** Mirror of the Rust `TunnelProbe` (`companion_api/tunnel.rs`). */
export interface TunnelProbe {
  installed: boolean
  path?: string | null
  version?: string | null
}

/**
 * Whether cloudflared is where the launcher will look, before anyone flips
 * the switch. `null` off the desktop or when the probe itself failed, which
 * callers treat as "unknown" rather than "missing".
 */
export async function probeTunnel(
  loader: () => Promise<TauriInvoker | null> = tauriInvoker
): Promise<TunnelProbe | null> {
  const invoker = await loader()
  if (!invoker) return null
  try {
    return await invoker.invoke<TunnelProbe>("companion_tunnel_probe")
  } catch {
    return null
  }
}

export async function stopTunnel(
  loader: () => Promise<TauriInvoker | null> = tauriInvoker
): Promise<{ kind: "stopped" } | { kind: "unsupported" }> {
  const invoker = await loader()
  if (!invoker) return { kind: "unsupported" }
  try {
    await invoker.invoke("companion_tunnel_stop")
  } catch {
    // Stop is best-effort.
  }
  return { kind: "stopped" }
}

export async function getTunnelInfo(
  loader: () => Promise<TauriInvoker | null> = tauriInvoker
): Promise<TunnelInfo | null> {
  const invoker = await loader()
  if (!invoker) return null
  try {
    return await invoker.invoke<TunnelInfo | null>("companion_tunnel_current")
  } catch {
    return null
  }
}

export async function getTunnelConfig(
  loader: () => Promise<TauriInvoker | null> = tauriInvoker
): Promise<TunnelConfigSummary | null> {
  const invoker = await loader()
  if (!invoker) return null
  try {
    return await invoker.invoke<TunnelConfigSummary>("companion_tunnel_get_config")
  } catch {
    return null
  }
}

export async function saveNamedTunnelConfig(
  token: string,
  hostname: string,
  loader: () => Promise<TauriInvoker | null> = tauriInvoker
): Promise<{ kind: "ok" } | { kind: "error"; message: string }> {
  const invoker = await loader()
  if (!invoker) return { kind: "error", message: "Tauri not available" }
  try {
    await invoker.invoke("companion_tunnel_save_named_config", { token, hostname })
    return { kind: "ok" }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    return { kind: "error", message: msg }
  }
}

export async function setTunnelMode(
  mode: "quick" | "named",
  loader: () => Promise<TauriInvoker | null> = tauriInvoker
): Promise<{ kind: "ok" } | { kind: "error"; message: string }> {
  const invoker = await loader()
  if (!invoker) return { kind: "error", message: "Tauri not available" }
  try {
    await invoker.invoke("companion_tunnel_set_mode", { mode })
    return { kind: "ok" }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    return { kind: "error", message: msg }
  }
}

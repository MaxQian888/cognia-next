"use client"

/**
 * Tunnel resolver (Wave 1.6) — desktop-side launcher controls + URL
 * resolution helpers. Talks to the Rust `companion_tunnel_*` Tauri
 * commands.
 */

export interface TunnelInfo {
  publicUrl: string
  localUrl: string
}

export interface TauriInvoker {
  invoke<T = unknown>(cmd: string, args?: Record<string, unknown>): Promise<T>
}

const tauriInvoker: () => Promise<TauriInvoker | null> = async () => {
  try {
    if (typeof window === "undefined") return null
    if (!("__TAURI_INTERNALS__" in window)) return null
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
  | { kind: "unsupported" }
  | { kind: "error"; message: string }

export async function startTunnel(
  localUrl: string,
  loader: () => Promise<TauriInvoker | null> = tauriInvoker
): Promise<StartOutcome> {
  const invoker = await loader()
  if (!invoker) return { kind: "unsupported" }
  try {
    const info = await invoker.invoke<TunnelInfo>("companion_tunnel_start", { localUrl })
    return { kind: "started", info }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    if (/not.installed|cloudflared.*not.found|enoent/i.test(msg)) {
      return { kind: "not_installed" }
    }
    return { kind: "error", message: msg }
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

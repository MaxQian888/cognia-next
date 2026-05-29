import { transport } from "@/lib/tauri"

/**
 * Thin wrappers over the `cua_sandbox_*` Tauri commands (ADR-0020
 * remote-target). Lifecycle only — driving actions ride the existing
 * `desktop.*` client with a `sandboxConnectionId` in their `CallContext`.
 */
export const sandboxClient = {
  /** Start (idempotently) the container for `connectionId`; returns the mapped host port. */
  start(connectionId: string, image: string): Promise<number> {
    return transport.call<number>("cua_sandbox_start", { connectionId, image })
  },
  /** Stop + remove the container for `connectionId`. */
  stop(connectionId: string): Promise<void> {
    return transport.call<void>("cua_sandbox_stop", { connectionId })
  },
  /** Whether the container for `connectionId` is currently running. */
  health(connectionId: string): Promise<boolean> {
    return transport.call<boolean>("cua_sandbox_health", { connectionId })
  },
}

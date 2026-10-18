import type { RemoteDesktopHostRef, RemoteDesktopSessionMode } from "./types"

/**
 * The viewer route for one binding. Ids only: never a URL, address or
 * ticket. `host` names the Host that owns the target when it is not this
 * desktop's own (a store Host id or `companion:<hostId>`).
 */
export const REMOTE_DESKTOP_VIEWER_PATH = "/devices/remote-desktop"

export function remoteDesktopViewerHref(input: {
  host: RemoteDesktopHostRef
  targetId: string
  bindingId: string
  mode: RemoteDesktopSessionMode
}): string {
  const params = new URLSearchParams({
    target: input.targetId,
    binding: input.bindingId,
    mode: input.mode,
  })
  if (input.host.kind === "remote") params.set("host", input.host.hostRef)
  return `${REMOTE_DESKTOP_VIEWER_PATH}?${params.toString()}`
}

export interface RemoteDesktopViewerParams {
  host: RemoteDesktopHostRef
  targetId: string
  bindingId: string
  mode: RemoteDesktopSessionMode
}

/** Read the viewer route's query; `null` when it does not name a binding. */
export function parseRemoteDesktopViewerParams(
  search: Pick<URLSearchParams, "get">
): RemoteDesktopViewerParams | null {
  const targetId = search.get("target")
  const bindingId = search.get("binding")
  if (!targetId || !bindingId) return null
  const hostRef = search.get("host")
  return {
    host: hostRef ? { kind: "remote", hostRef } : { kind: "local" },
    targetId,
    bindingId,
    mode: search.get("mode") === "view" ? "view" : "control",
  }
}

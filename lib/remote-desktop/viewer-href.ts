import type { RemoteDesktopSessionMode } from "./types"

/** The viewer route for one binding. Ids only: never a URL, host or ticket. */
export const REMOTE_DESKTOP_VIEWER_PATH = "/devices/remote-desktop"

export function remoteDesktopViewerHref(input: {
  targetId: string
  bindingId: string
  mode: RemoteDesktopSessionMode
}): string {
  const params = new URLSearchParams({
    target: input.targetId,
    binding: input.bindingId,
    mode: input.mode,
  })
  return `${REMOTE_DESKTOP_VIEWER_PATH}?${params.toString()}`
}

export interface RemoteDesktopViewerParams {
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
  return { targetId, bindingId, mode: search.get("mode") === "view" ? "view" : "control" }
}

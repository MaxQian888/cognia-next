/**
 * The renderer's client for the Host's remote desktop commands (ADR-0234
 * Phase 2). They are `client`-target and desktop-only: the browser and phone
 * builds reach them in Phase 3.
 */

import { transport } from "@/lib/tauri"

import type {
  RemoteDesktopCredentialKind,
  RemoteDesktopProbeOutcome,
  RemoteDesktopProbeRequest,
  RemoteDesktopSessionMode,
  RemoteDesktopSessionOpened,
  RemoteDesktopSessionRenewed,
  RemoteDesktopTarget,
  RemoteDesktopTargetDraft,
  RemoteDesktopTargetPage,
} from "./types"

/** How often an open session renews; the Host closes it after 15 s without. */
export const REMOTE_DESKTOP_RENEW_MS = 5_000

/** A Host refusal: its stable `remote_desktop_*` code and an optional detail. */
export class RemoteDesktopError extends Error {
  constructor(
    readonly code: string,
    readonly detail?: string
  ) {
    super(detail ? `${code}: ${detail}` : code)
    this.name = "RemoteDesktopError"
  }
}

const CODE = /^(remote_desktop_[a-z_]+)(?::\s*([\s\S]*))?$/

/** Read a Host refusal out of whatever the transport rejected with. */
export function toRemoteDesktopError(error: unknown): RemoteDesktopError {
  if (error instanceof RemoteDesktopError) return error
  const message =
    typeof error === "string"
      ? error
      : error instanceof Error
        ? error.message
        : typeof (error as { message?: unknown })?.message === "string"
          ? (error as { message: string }).message
          : ""
  const match = CODE.exec(message.trim())
  if (match) return new RemoteDesktopError(match[1]!, match[2]?.trim() || undefined)
  return new RemoteDesktopError("remote_desktop_unavailable", message || undefined)
}

async function call<T>(command: string, args: Record<string, unknown>): Promise<T> {
  try {
    return await transport.call<T>(command, args)
  } catch (error) {
    throw toRemoteDesktopError(error)
  }
}

/** Every saved target; the store holds at most 256, so this walks the pages. */
export async function listRemoteDesktopTargets(): Promise<RemoteDesktopTarget[]> {
  const targets: RemoteDesktopTarget[] = []
  let pageToken: string | undefined
  for (let pages = 0; pages < 64; pages += 1) {
    const page = await call<RemoteDesktopTargetPage>("remote_desktop_target_list", {
      pageSize: 100,
      ...(pageToken ? { pageToken } : {}),
    })
    targets.push(...page.items)
    if (!page.nextPageToken) return targets
    pageToken = page.nextPageToken
  }
  return targets
}

export function saveRemoteDesktopTarget(
  draft: RemoteDesktopTargetDraft
): Promise<RemoteDesktopTarget> {
  return call("remote_desktop_target_save", { draft })
}

export function deleteRemoteDesktopTarget(targetId: string): Promise<void> {
  return call("remote_desktop_target_delete", { targetId })
}

/** `value: null` clears the credential. The value is never readable again. */
export function setRemoteDesktopCredential(
  targetId: string,
  bindingId: string,
  kind: RemoteDesktopCredentialKind,
  value: string | null
): Promise<RemoteDesktopTarget> {
  return call("remote_desktop_credential_set", { targetId, bindingId, kind, value })
}

export function probeRemoteDesktop(
  request: RemoteDesktopProbeRequest
): Promise<RemoteDesktopProbeOutcome> {
  return call("remote_desktop_target_probe", { request })
}

export function openRemoteDesktopSession(input: {
  targetId: string
  bindingId: string
  mode: RemoteDesktopSessionMode
  takeover: boolean
}): Promise<RemoteDesktopSessionOpened> {
  return call("remote_desktop_session_open", input)
}

export function renewRemoteDesktopSession(sessionId: string): Promise<RemoteDesktopSessionRenewed> {
  return call("remote_desktop_session_renew", { sessionId })
}

export function closeRemoteDesktopSession(sessionId: string): Promise<void> {
  return call("remote_desktop_session_close", { sessionId })
}

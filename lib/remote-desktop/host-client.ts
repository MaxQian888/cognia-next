/**
 * The client for a Host's remote desktop commands (ADR-0234 Phases 2 and 3).
 *
 * Every call names the Host it goes to. This desktop's own Host is reached as
 * the local owner through `remote_desktop_local_call`; any other Host (a store
 * Host this desktop manages, or the `/pair` Host a phone or browser is
 * connected to) through its management channel, as a paired device. Changing
 * what a remote Host can reach, probing an endpoint and taking control carry a
 * short-lived host admin lease (ADR-0153), issued on the user's action and
 * cached per transport like the managed desktop client's.
 */

import { withManagementChannel } from "@/lib/remote-host/management-channel"
import {
  HostConsentRequiredError,
  issueHostAdminLease,
  type HostAdminLease,
} from "@/lib/tauri/admin-lease"
import { localTransport } from "@/lib/tauri/transport-instance"
import type { Transport } from "@/lib/tauri/transport-types"

import type {
  RemoteDesktopCredentialKind,
  RemoteDesktopHostRef,
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

/** What one host admin lease covers: every remote desktop admin operation. */
export const REMOTE_DESKTOP_ADMIN_OPERATIONS = [
  "remote_desktop_target_save",
  "remote_desktop_target_delete",
  "remote_desktop_credential_set",
  "remote_desktop_target_probe",
  "remote_desktop_session_open",
] as const

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
/** A Host too old to know the commands (Phase 2 or earlier on a remote). */
const UNKNOWN_COMMAND = /unknown_command|command_transport_forbidden|not a known command/i

/** Read a Host refusal out of whatever the transport rejected with. */
export function toRemoteDesktopError(error: unknown): RemoteDesktopError {
  if (error instanceof RemoteDesktopError) return error
  if (error instanceof HostConsentRequiredError) {
    return new RemoteDesktopError(
      "remote_desktop_host_consent_required",
      error.consentCode ?? undefined
    )
  }
  const message =
    typeof error === "string"
      ? error
      : error instanceof Error
        ? error.message
        : typeof (error as { message?: unknown })?.message === "string"
          ? (error as { message: string }).message
          : ""
  const code =
    typeof (error as { code?: unknown })?.code === "string" ? (error as { code: string }).code : ""
  const match = CODE.exec(message.trim()) ?? CODE.exec(code)
  if (match) return new RemoteDesktopError(match[1]!, match[2]?.trim() || undefined)
  if (UNKNOWN_COMMAND.test(code) || UNKNOWN_COMMAND.test(message)) {
    return new RemoteDesktopError("remote_desktop_host_outdated")
  }
  if (/interactive_approval_required|REMOTE_CONSENT_REQUIRED/.test(`${code} ${message}`)) {
    return new RemoteDesktopError("remote_desktop_admin_lease_required")
  }
  return new RemoteDesktopError("remote_desktop_unavailable", message || undefined)
}

function needsAdmin(name: string, args: Record<string, unknown>): boolean {
  if (name === "remote_desktop_session_open") return args.mode !== "view"
  return (REMOTE_DESKTOP_ADMIN_OPERATIONS as readonly string[]).includes(name)
}

// Tied to the transport object, never a display id: re-pairing replaces the
// transport, so a lease minted for the old pairing is never reused.
const adminLeases = new WeakMap<Transport, HostAdminLease>()

export interface RemoteDesktopClientDeps {
  local?: Pick<Transport, "call">
  withChannel?: <T>(
    hostRef: string,
    work: (lease: { transport: Transport }) => Promise<T>
  ) => Promise<T>
  issueLease?: typeof issueHostAdminLease
  now?: () => number
}

let deps: RemoteDesktopClientDeps = {}

/** Test seam. */
export function __setRemoteDesktopClientDepsForTests(next: RemoteDesktopClientDeps = {}): void {
  deps = next
}

async function callRemote<T>(
  hostRef: string,
  name: string,
  args: Record<string, unknown>
): Promise<T> {
  const withChannel = deps.withChannel ?? withManagementChannel
  const now = deps.now ?? Date.now
  return withChannel(hostRef, async ({ transport }) => {
    if (!needsAdmin(name, args)) return transport.call<T>(name, args)
    let lease = adminLeases.get(transport)
    if (!lease || lease.expiresAt <= now() + 5_000 || !lease.operations.includes(name)) {
      lease = await (deps.issueLease ?? issueHostAdminLease)(
        [...REMOTE_DESKTOP_ADMIN_OPERATIONS],
        600,
        transport
      )
      adminLeases.set(transport, lease)
    }
    try {
      return await transport.call<T>(name, { ...args, adminLease: lease.token })
    } catch (error) {
      const refused = toRemoteDesktopError(error)
      if (
        refused.code === "remote_desktop_admin_lease_required" &&
        adminLeases.get(transport) === lease
      ) {
        adminLeases.delete(transport)
      }
      throw error
    }
  })
}

async function call<T>(
  host: RemoteDesktopHostRef,
  name: string,
  args: Record<string, unknown>
): Promise<T> {
  try {
    if (host.kind === "local") {
      return await (deps.local ?? localTransport).call<T>("remote_desktop_local_call", {
        name,
        args,
      })
    }
    return await callRemote<T>(host.hostRef, name, args)
  } catch (error) {
    throw toRemoteDesktopError(error)
  }
}

/** Every saved target; the store holds at most 256, so this walks the pages. */
export async function listRemoteDesktopTargets(
  host: RemoteDesktopHostRef
): Promise<RemoteDesktopTarget[]> {
  const targets: RemoteDesktopTarget[] = []
  let pageToken: string | undefined
  for (let pages = 0; pages < 64; pages += 1) {
    const page = await call<RemoteDesktopTargetPage>(host, "remote_desktop_target_list", {
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
  host: RemoteDesktopHostRef,
  draft: RemoteDesktopTargetDraft
): Promise<RemoteDesktopTarget> {
  return call(host, "remote_desktop_target_save", { draft })
}

export async function deleteRemoteDesktopTarget(
  host: RemoteDesktopHostRef,
  targetId: string
): Promise<void> {
  await call(host, "remote_desktop_target_delete", { targetId })
}

/** `value: null` clears the credential. The value is never readable again. */
export function setRemoteDesktopCredential(
  host: RemoteDesktopHostRef,
  targetId: string,
  bindingId: string,
  kind: RemoteDesktopCredentialKind,
  value: string | null
): Promise<RemoteDesktopTarget> {
  return call(host, "remote_desktop_credential_set", { targetId, bindingId, kind, value })
}

export function probeRemoteDesktop(
  host: RemoteDesktopHostRef,
  request: RemoteDesktopProbeRequest
): Promise<RemoteDesktopProbeOutcome> {
  return call(host, "remote_desktop_target_probe", { request })
}

export function openRemoteDesktopSession(
  host: RemoteDesktopHostRef,
  input: {
    targetId: string
    bindingId: string
    mode: RemoteDesktopSessionMode
    takeover: boolean
  }
): Promise<RemoteDesktopSessionOpened> {
  return call(host, "remote_desktop_session_open", input)
}

export function renewRemoteDesktopSession(
  host: RemoteDesktopHostRef,
  sessionId: string
): Promise<RemoteDesktopSessionRenewed> {
  return call(host, "remote_desktop_session_renew", { sessionId })
}

export async function closeRemoteDesktopSession(
  host: RemoteDesktopHostRef,
  sessionId: string
): Promise<void> {
  await call(host, "remote_desktop_session_close", { sessionId })
}

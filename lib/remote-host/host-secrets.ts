/**
 * "Secrets on this host" from the desktop that manages it (ADR-0224 A6).
 *
 * Every call goes over the host's management channel, never the desktop's
 * routing: the panel manages one host while the desktop keeps working on its
 * own. Values only ever go to the host. The list it reads back is names,
 * kinds, when each was set and by which paired device.
 *
 * Provider keys and git tokens are written and removed here. Connector
 * credentials are listed, because they are secrets on the host too, but they
 * belong to their connection: they are set and removed with it, and removing
 * one here would leave a connection that cannot sign in.
 */

import { ALWAYS_ON_SECRETS_HOST_OPERATIONS } from "@/lib/platform/host-feature-manifest"
import {
  withManagementChannel,
  type ManagementChannelDeps,
} from "@/lib/remote-host/management-channel"
import { issueHostAdminLease, type HostAdminLease } from "@/lib/tauri/admin-lease"
import { collectPages, type Page } from "@/lib/tauri/companion-paging"
import { refreshRemoteHostKeys } from "@/lib/host-secrets/remote-host-keys"

export type HostSecretKind = "provider" | "git" | "connector"

export interface HostSecretEntry {
  kind: HostSecretKind
  /** Provider id, git host (`github.com`), or `<adapterId>:<credential>`. */
  name: string
  /** Unix milliseconds; absent for a secret set before the host recorded it. */
  setAt?: number
  /** Absent when the host set it for itself. */
  setBy?: { deviceId: string; label?: string }
}

/** The writes one admin lease covers; the list needs none. */
export const HOST_SECRET_LEASE_OPERATIONS = ALWAYS_ON_SECRETS_HOST_OPERATIONS.filter(
  (operation) => operation !== "host_secret_list"
)

/** A lease long enough to paste a few keys, short enough to be worth asking for. */
const HOST_SECRET_LEASE_TTL_SECONDS = 10 * 60

export interface HostSecretDeps {
  channel?: ManagementChannelDeps
}

/** Whether `kind` is written and removed from the secrets panel. */
export function isManagedHere(kind: HostSecretKind): kind is "provider" | "git" {
  return kind === "provider" || kind === "git"
}

/** The most a page holds (the contract's ceiling), so a host answers in one page. */
const HOST_SECRET_PAGE_SIZE = 1000

/**
 * Every secret on the host. The list pages by token (ADR-0175 B3); the panel
 * shows all of them, so the walk must finish: a list cut short would hide a
 * secret the person came here to remove.
 */
export function listHostSecrets(
  hostId: string,
  deps: HostSecretDeps = {}
): Promise<HostSecretEntry[]> {
  return withManagementChannel(
    hostId,
    (lease) =>
      collectPages(
        async (pageToken) => {
          const answer = await lease.transport.call<Partial<Page<HostSecretEntry>> | null>(
            "host_secret_list",
            { pageSize: HOST_SECRET_PAGE_SIZE, ...(pageToken ? { pageToken } : {}) }
          )
          return {
            items: Array.isArray(answer?.items) ? answer.items : [],
            ...(typeof answer?.nextPageToken === "string"
              ? { nextPageToken: answer.nextPageToken }
              : {}),
          }
        },
        { requireComplete: true }
      ),
    deps.channel
  )
}

/**
 * Ask the host for the lease the panel's writes use. Only from a user's
 * action: a host waiting on a person answers `HostConsentRequiredError`.
 */
export function requestHostSecretsLease(
  hostId: string,
  deps: HostSecretDeps = {}
): Promise<HostAdminLease> {
  return withManagementChannel(
    hostId,
    (lease) =>
      issueHostAdminLease(
        [...HOST_SECRET_LEASE_OPERATIONS],
        HOST_SECRET_LEASE_TTL_SECONDS,
        lease.transport
      ),
    deps.channel
  )
}

export interface HostSecretWrite {
  kind: "provider" | "git"
  /** Provider id, or the git host (a URL is fine: the host normalizes it). */
  name: string
  value: string
}

/** Seal a provider key or git token; resolves to the name the host stored. */
export function setHostSecret(
  hostId: string,
  write: HostSecretWrite,
  adminLease: string,
  deps: HostSecretDeps = {}
): Promise<{ kind: "provider" | "git"; name: string }> {
  const [command, args] =
    write.kind === "provider"
      ? ([
          "host_provider_credential_set",
          { providerId: write.name.trim(), apiKey: write.value.trim(), adminLease },
        ] as const)
      : ([
          "host_git_credential_set",
          { host: write.name.trim(), token: write.value.trim(), adminLease },
        ] as const)
  return withManagementChannel(
    hostId,
    (lease) => lease.transport.call<{ kind: "provider" | "git"; name: string }>(command, args),
    deps.channel
  ).then((stored) => {
    // The picker lists what the driven Host keys; it changed.
    if (write.kind === "provider") refreshRemoteHostKeys()
    return stored
  })
}

export function deleteHostSecret(
  hostId: string,
  entry: Pick<HostSecretEntry, "kind" | "name">,
  adminLease: string,
  deps: HostSecretDeps = {}
): Promise<void> {
  if (!isManagedHere(entry.kind)) {
    return Promise.reject(new Error("connector credentials are removed with their connection"))
  }
  const [command, args] =
    entry.kind === "provider"
      ? (["host_provider_credential_delete", { providerId: entry.name, adminLease }] as const)
      : (["host_git_credential_delete", { host: entry.name, adminLease }] as const)
  return withManagementChannel(
    hostId,
    (lease) => lease.transport.call<void>(command, args),
    deps.channel
  ).then(() => {
    if (entry.kind === "provider") refreshRemoteHostKeys()
  })
}

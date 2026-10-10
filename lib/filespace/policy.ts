/**
 * The file-sharing policy that applies right now (ADR-0222 §6.4, §9.1).
 *
 * Two inputs: the person's own policy (`AppSettings.fileSharing`, defaults
 * below) and, when the account belongs to a collaboration org, the org's
 * policy from the plane. The effective policy is their field-wise
 * intersection — a switch is on only when both allow it, a ceiling is the
 * lower of the two — so neither side can widen the other. With no org it is
 * the local policy alone.
 *
 * The client uses it to offer only what is allowed; the server re-checks the
 * org half where it can (a shared conversation's file share is authorized by
 * the plane, see `assertSharedSessionFileShare`).
 */

import type { AppSettings, FileSharingPolicySettings } from "@cognia/agent-config-types"
import { getSettings } from "@/lib/db/settings"
import type { CollabFileSharingPolicy } from "@/lib/collab/client"
import { getOrgFileSharingPolicy } from "@/lib/collab/file-sharing-policy"
import { resolveCurrentCollabContext, type CurrentCollabContext } from "@/lib/collab/runtime-client"

/** Every field resolved. */
export type FileSharingPolicy = Required<FileSharingPolicySettings>

/** No ceiling below an hour (the shortest link offered) or above a year. */
export const FILE_SHARING_MIN_TTL_SECONDS = 60 * 60
export const FILE_SHARING_MAX_TTL_SECONDS = 365 * 24 * 60 * 60

/**
 * Conservative where a mistake is hard to take back: network-drive
 * credentials, writes and agent sharing start off. Mirrors the server's
 * defaults in `crates/cognia-collab-server/src/file_sharing.rs`.
 */
export const DEFAULT_FILE_SHARING_POLICY: FileSharingPolicy = {
  allowPublicSnapshots: true,
  allowLiveGrants: true,
  allowProtocolCredentials: false,
  allowLiveWrite: false,
  allowAgentSharing: false,
  maxSnapshotTtlSeconds: 30 * 24 * 60 * 60,
  maxLiveTtlSeconds: 7 * 24 * 60 * 60,
}

function ttl(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback
  return Math.min(
    FILE_SHARING_MAX_TTL_SECONDS,
    Math.max(FILE_SHARING_MIN_TTL_SECONDS, Math.floor(value))
  )
}

function flag(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback
}

/**
 * The person's own policy with every field resolved. Live write and network
 * credentials are meaningless without live access, so they read as off when
 * it is.
 */
export function resolveLocalFileSharingPolicy(
  stored: AppSettings["fileSharing"] | undefined
): FileSharingPolicy {
  const defaults = DEFAULT_FILE_SHARING_POLICY
  const allowLiveGrants = flag(stored?.allowLiveGrants, defaults.allowLiveGrants)
  return {
    allowPublicSnapshots: flag(stored?.allowPublicSnapshots, defaults.allowPublicSnapshots),
    allowLiveGrants,
    allowProtocolCredentials:
      allowLiveGrants && flag(stored?.allowProtocolCredentials, defaults.allowProtocolCredentials),
    allowLiveWrite: allowLiveGrants && flag(stored?.allowLiveWrite, defaults.allowLiveWrite),
    allowAgentSharing: flag(stored?.allowAgentSharing, defaults.allowAgentSharing),
    maxSnapshotTtlSeconds: ttl(stored?.maxSnapshotTtlSeconds, defaults.maxSnapshotTtlSeconds),
    maxLiveTtlSeconds: ttl(stored?.maxLiveTtlSeconds, defaults.maxLiveTtlSeconds),
  }
}

/** The field-wise most restrictive of two policies. */
export function intersectFileSharingPolicies(
  local: FileSharingPolicy,
  org: FileSharingPolicySettings | null | undefined
): FileSharingPolicy {
  if (!org) return local
  const both = (key: keyof FileSharingPolicy & `allow${string}`) =>
    Boolean(local[key]) && org[key] !== false
  const lower = (key: "maxSnapshotTtlSeconds" | "maxLiveTtlSeconds") =>
    typeof org[key] === "number" ? Math.min(local[key], org[key]) : local[key]
  return {
    allowPublicSnapshots: both("allowPublicSnapshots"),
    allowLiveGrants: both("allowLiveGrants"),
    allowProtocolCredentials: both("allowProtocolCredentials"),
    allowLiveWrite: both("allowLiveWrite"),
    allowAgentSharing: both("allowAgentSharing"),
    maxSnapshotTtlSeconds: lower("maxSnapshotTtlSeconds"),
    maxLiveTtlSeconds: lower("maxLiveTtlSeconds"),
  }
}

/** Which side made a field what it is, for the UI to say why. */
export interface EffectiveFileSharingPolicy {
  policy: FileSharingPolicy
  local: FileSharingPolicy
  /** Present when the account belongs to a collaboration org. */
  org?: { orgId: string; policy: CollabFileSharingPolicy }
  /**
   * The account belongs to an org whose policy could not be read. The
   * effective policy then refuses everything the org could have forbidden
   * rather than guessing it allowed them.
   */
  orgUnavailable?: boolean
}

/** The org policy an unreachable plane is treated as: nothing allowed. */
const ORG_UNREACHABLE: FileSharingPolicySettings = {
  allowPublicSnapshots: false,
  allowLiveGrants: false,
  allowProtocolCredentials: false,
  allowLiveWrite: false,
  allowAgentSharing: false,
}

export interface EffectivePolicyDeps {
  readSettings: () => Promise<Pick<AppSettings, "fileSharing">>
  resolveCollabContext: () => Promise<CurrentCollabContext | null>
  readOrgPolicy: typeof getOrgFileSharingPolicy
}

export const defaultEffectivePolicyDeps: EffectivePolicyDeps = {
  readSettings: getSettings,
  resolveCollabContext: () => resolveCurrentCollabContext(),
  readOrgPolicy: getOrgFileSharingPolicy,
}

/**
 * Load the effective policy. `minOrgRevision` comes from a server answer that
 * named a newer revision than the cached one (see
 * `assertSharedSessionFileShare`).
 */
export async function loadEffectiveFileSharingPolicy(
  options: { minOrgRevision?: number; refreshOrg?: boolean } = {},
  deps: EffectivePolicyDeps = defaultEffectivePolicyDeps
): Promise<EffectiveFileSharingPolicy> {
  // A lookup that fails (rather than finding no connection) cannot say the
  // account is outside an org, so it is treated like an unreadable org policy.
  const [settings, context] = await Promise.all([
    deps.readSettings(),
    deps.resolveCollabContext().catch(() => "unknown" as const),
  ])
  const local = resolveLocalFileSharingPolicy(settings.fileSharing)
  if (!context) return { policy: local, local }
  const unreadable = (): EffectiveFileSharingPolicy => ({
    policy: intersectFileSharingPolicies(local, ORG_UNREACHABLE),
    local,
    orgUnavailable: true,
  })
  if (context === "unknown") return unreadable()
  try {
    const org = await deps.readOrgPolicy(context, {
      minRevision: options.minOrgRevision,
      refresh: options.refreshOrg,
    })
    return {
      policy: intersectFileSharingPolicies(local, org),
      local,
      org: { orgId: context.orgId, policy: org },
    }
  } catch {
    return unreadable()
  }
}

/** Why a snapshot share with files is refused, or `null`. */
export type SnapshotFileShareDenial = "public-snapshots-disabled" | "ttl-exceeds-policy"

/**
 * Check one snapshot share against a policy. `ttlSeconds` absent means the
 * server's own maximum, which a ceiling below it refuses: the share must ask
 * for a lifetime the policy allows.
 */
export function checkSnapshotFileShare(
  policy: FileSharingPolicy,
  ttlSeconds: number | undefined
): SnapshotFileShareDenial | null {
  if (!policy.allowPublicSnapshots) return "public-snapshots-disabled"
  if (ttlSeconds === undefined || ttlSeconds > policy.maxSnapshotTtlSeconds) {
    return "ttl-exceeds-policy"
  }
  return null
}

/** The lifetimes a policy ceiling is chosen from, shortest first. */
export const FILE_SHARING_TTL_PRESETS_SECONDS: readonly number[] = [
  60 * 60,
  24 * 60 * 60,
  7 * 24 * 60 * 60,
  30 * 24 * 60 * 60,
  90 * 24 * 60 * 60,
  FILE_SHARING_MAX_TTL_SECONDS,
]

/**
 * Apply one edit to a policy, keeping it one the plane would accept: network
 * credentials and live write need live access, so turning live access off
 * turns them off, and turning either on turns live access on.
 */
export function editFileSharingPolicy(
  policy: FileSharingPolicy,
  patch: Partial<FileSharingPolicy>
): FileSharingPolicy {
  const next = { ...policy, ...patch }
  if (patch.allowLiveGrants === false) {
    next.allowProtocolCredentials = false
    next.allowLiveWrite = false
  } else if (patch.allowProtocolCredentials || patch.allowLiveWrite) {
    next.allowLiveGrants = true
  }
  return next
}

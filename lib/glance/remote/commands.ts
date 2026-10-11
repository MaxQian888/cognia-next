// The companion wire names for glance on a paired phone (ADR-0225 §7, §9).
//
// One list, read by both halves: the host's dispatch family
// (`host-dispatch.ts`, delegated from `lib/companion/desktop-write-source.ts`)
// and the phone's client (`client.ts`). The contract itself is
// `protocol/companion-commands.json`; `commands.test.ts` holds this list equal
// to the `glance.*` descriptors there, so a command added on one side fails a
// test instead of answering `unknown desktop-write command`.
//
// The snapshot itself does not come back over these calls after the first
// one: while a phone holds a lease, the desktop pushes every new snapshot on
// the `glance://update` event channel, the way `fleet://update` carries the
// Fleet mirror.

export const GLANCE_REMOTE_COMMANDS = {
  /** Announce, renew or end a lease with the phone's demand; answers the newest snapshot. */
  subscribe: "glance_subscribe",
  /** Re-read now: everything, or one quota source. */
  request: "glance_request",
  /** Turn quota queries on for a vault account: a settings write on the desktop. */
  quotaEnable: "glance_quota_enable",
} as const

export type GlanceRemoteCommand =
  (typeof GLANCE_REMOTE_COMMANDS)[keyof typeof GLANCE_REMOTE_COMMANDS]

export const GLANCE_REMOTE_COMMAND_NAMES: readonly GlanceRemoteCommand[] =
  Object.values(GLANCE_REMOTE_COMMANDS)

const NAME_SET: ReadonlySet<string> = new Set(GLANCE_REMOTE_COMMAND_NAMES)

export function isGlanceRemoteCommand(command: string): command is GlanceRemoteCommand {
  return NAME_SET.has(command)
}

/** The event channel snapshots are pushed on while a phone holds a lease. */
export const GLANCE_UPDATE_EVENT = "glance://update"

/** The host feature a desktop advertises when it serves glance to paired phones. */
export const GLANCE_REMOTE_FEATURE = "glance.remote"

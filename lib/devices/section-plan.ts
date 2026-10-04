/**
 * Which cards the device dashboard shows, in what order, and at what width.
 *
 * The dashboard used to be one fixed sequence for every kind of machine:
 * identity, presence, capabilities, access, runtime, activity. That order is
 * right for nobody. Owning a phone is mostly about its grants, and those sat
 * below a twenty-row capability matrix. Driving a remote host is about its
 * workspaces and routing, and those sat below an Access card whose whole
 * content was a sentence saying a host is not granted anything. So the order is
 * now per kind and task-first: what the owner comes to the device to *do*
 * leads, the records describing it follow, and the diagnostic matrices close.
 *
 * Cards that have nothing to say for this kind are not rendered as cards at
 * all. Each one used to be a frame around a single sentence (the
 * "list of excuses" `ShellOnlySection` was written to stop for SSH hosts), and
 * the same thing was true of a phone's sandbox and workspaces or a host's
 * Access. They are gathered into one record, {@link DeviceSectionPlan.notApplicable},
 * stated once at the end in the same words the cards would have used.
 *
 * Pure, so the plan the grid lays out and the plan the jump navigation lists
 * are the same value: a nav entry can never point at a card that did not render.
 */

import { dispatchTargetRef } from "./build-device-rows"
import type { DeviceKind, DeviceRow } from "./types"

export type DeviceSectionId =
  | "ssh"
  | "files"
  | "access"
  | "wan"
  | "routing"
  | "shell-tiers"
  | "sandbox"
  | "workspaces"
  | "identity"
  | "presence"
  | "event-plane"
  | "capabilities"
  | "dispatch"
  | "placement"

export interface DevicePlannedSection {
  id: DeviceSectionId
  /** Spans both grid columns. Matrices, registries and lists; never fact pairs. */
  wide: boolean
}

/** What a card would have said had it rendered, as one row of a shared record. */
export type DeviceNotApplicableId =
  "capabilities" | "access" | "sandbox" | "workspaces" | "runtime" | "dispatch" | "placement"

export interface DeviceNotApplicable {
  id: DeviceNotApplicableId
  /** Full key under the `devices` namespace for the row label. */
  labelKey: string
  /** Full key under the `devices` namespace for the sentence. */
  reasonKey: string
}

export interface DeviceSectionPlan {
  sections: DevicePlannedSection[]
  notApplicable: DeviceNotApplicable[]
  /**
   * Whether the not-applicable record spans the grid. Two rows or fewer are a
   * fact pair, and a full-width frame around them is the 90px stub the grid
   * exists to avoid.
   */
  notApplicableWide: boolean
}

/** The anchor the not-applicable record carries, for the jump navigation. */
export const NOT_APPLICABLE_SECTION_ID = "not-applicable"

const WIDE: Record<DeviceSectionId, boolean> = {
  ssh: true,
  files: true,
  access: true,
  wan: false,
  routing: false,
  "shell-tiers": false,
  sandbox: true,
  workspaces: true,
  identity: false,
  presence: false,
  "event-plane": false,
  capabilities: true,
  dispatch: true,
  placement: false,
}

/**
 * Task-first order per kind. A section listed here still only renders when
 * {@link isApplicable} says it has something to show.
 *
 *  * `local` What this window runs on: where calls land, which shells and
 *    machines it has, which worktrees. Its identity is the least interesting
 *    thing about it.
 *  * `paired-device` What the phone may do here, then whether it can be
 *    reached at all, then who it is.
 *  * `remote-host` Its worktrees and whether it owns timing. Connecting lives
 *    in the masthead, so the first card is already about using it.
 *  * `worker` Nothing to configure: who it is and what it has been sent.
 *  * `ssh-host` The connection record and the files are the whole machine.
 */
const ORDER: Record<DeviceKind, readonly DeviceSectionId[]> = {
  local: [
    "routing",
    "shell-tiers",
    "workspaces",
    "sandbox",
    "identity",
    "presence",
    "event-plane",
    "capabilities",
    "dispatch",
    "placement",
  ],
  "paired-device": [
    "access",
    "wan",
    "presence",
    "event-plane",
    "identity",
    "dispatch",
    "capabilities",
    "placement",
  ],
  "remote-host": [
    "workspaces",
    "routing",
    "shell-tiers",
    "identity",
    "presence",
    "event-plane",
    "capabilities",
    "dispatch",
    "placement",
  ],
  worker: ["identity", "presence", "event-plane", "dispatch", "placement", "capabilities"],
  "ssh-host": ["ssh", "files", "identity", "presence"],
}

/**
 * Whether the scheduled-timing switch can be honoured for this row.
 *
 * `ExecutionAuthorityConfig.hostId` is a `RemoteHost.id`, or null for self. A
 * phone or a worker cannot be named, and a `/pair` Host has its `hostId`
 * stripped because the store cannot address it.
 */
export function canOwnTiming(row: DeviceRow): boolean {
  return row.kind === "local" || (row.kind === "remote-host" && Boolean(row.hostId))
}

function isApplicable(row: DeviceRow, id: DeviceSectionId): boolean {
  switch (id) {
    case "ssh":
    case "files":
      return row.kind === "ssh-host"
    case "access":
      return row.kind === "paired-device"
    case "wan":
      return row.kind === "paired-device" && Boolean(row.wan)
    case "routing":
      return canOwnTiming(row) || row.runtime.isRoutingTarget
    case "shell-tiers":
      return row.runtime.shellTiers.length > 0
    case "sandbox":
      return row.runtime.sandbox.support === "supported"
    case "workspaces":
      return row.runtime.workspaces.support !== "unsupported"
    case "identity":
    case "presence":
      return true
    case "event-plane":
      return Boolean(row.presence)
    case "capabilities":
      return row.capabilities.length > 0
    case "dispatch":
      return Boolean(dispatchTargetRef(row))
    case "placement":
      return row.kind !== "ssh-host"
  }
}

/**
 * The record of cards that did not render, in the order a reader would have
 * met them.
 *
 * An SSH host gets one `runtime` row for sandbox and workspaces together,
 * because `sshShellOnly` is one sentence answering both; every other kind
 * gets the reason each runtime surface carries on the row itself.
 */
function notApplicableFor(row: DeviceRow): DeviceNotApplicable[] {
  const entries: DeviceNotApplicable[] = []
  if (!isApplicable(row, "capabilities")) {
    entries.push({
      id: "capabilities",
      labelKey: "capabilities.title",
      reasonKey: `capabilities.noVocabulary.${row.kind}`,
    })
  }
  if (!isApplicable(row, "access")) {
    entries.push({
      id: "access",
      labelKey: "access.title",
      reasonKey: `access.notApplicable.${row.kind}`,
    })
  }
  if (row.kind === "ssh-host") {
    entries.push({
      id: "runtime",
      labelKey: "notApplicable.runtime",
      reasonKey: "runtime.reason.sshShellOnly",
    })
  } else {
    if (!isApplicable(row, "sandbox")) {
      entries.push({
        id: "sandbox",
        labelKey: "runtime.sandbox",
        reasonKey: `runtime.reason.${row.runtime.sandbox.reasonKey ?? "sandboxNotHosted"}`,
      })
    }
    if (!isApplicable(row, "workspaces")) {
      entries.push({
        id: "workspaces",
        labelKey: "runtime.workspaces",
        reasonKey: `runtime.reason.${row.runtime.workspaces.reasonKey ?? "workspaceNotHosted"}`,
      })
    }
  }
  if (!isApplicable(row, "dispatch")) {
    entries.push({
      id: "dispatch",
      labelKey: "activity.dispatch",
      reasonKey: "activity.dispatchNotAddressable",
    })
  }
  if (!isApplicable(row, "placement")) {
    entries.push({
      id: "placement",
      labelKey: "activity.placement",
      reasonKey: "activity.providesNothing",
    })
  }
  return entries
}

/**
 * Keep half-width cards in pairs without leaving the priority order.
 *
 * The grid is two columns with `items-start`, and a half card followed by a
 * wide one leaves the column beside it empty for the wide card's whole height
 * above. CSS `grid-auto-flow: dense` would fill that hole, but by moving a
 * card visually away from its place in the DOM, which is the reading and tab
 * order. Instead the next half card is pulled forward in the list itself, so
 * what is seen and what is focused next are still the same thing.
 *
 * Only ever pulls a card *up*, and only the nearest one, so the highest
 * priority card of a kind stays first.
 */
export function packHalfSections(
  sections: readonly DevicePlannedSection[]
): DevicePlannedSection[] {
  const queue = [...sections]
  const packed: DevicePlannedSection[] = []
  while (queue.length > 0) {
    const current = queue.shift()!
    packed.push(current)
    if (current.wide) continue
    const next = queue[0]
    if (!next) break
    if (!next.wide) {
      // Already paired: emit both so the next iteration starts a fresh row.
      packed.push(queue.shift()!)
      continue
    }
    const partnerIndex = queue.findIndex((candidate) => !candidate.wide)
    if (partnerIndex > 0) packed.push(...queue.splice(partnerIndex, 1))
  }
  return packed
}

export function planDeviceSections(row: DeviceRow): DeviceSectionPlan {
  const sections = packHalfSections(
    ORDER[row.kind].filter((id) => isApplicable(row, id)).map((id) => ({ id, wide: WIDE[id] }))
  )
  const notApplicable = notApplicableFor(row)
  return { sections, notApplicable, notApplicableWide: notApplicable.length > 2 }
}

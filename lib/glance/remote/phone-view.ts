/**
 * What a phone renders (ADR-0225 §9): its own slices and the desktop's,
 * merged into one snapshot, and where each module's data came from.
 *
 * A standalone phone builds every slice from its own data. A paired phone
 * builds the recents (sessions sync) itself and takes the rest
 * from the desktop (`GLANCE_HOST_MODULES`), labelling each of those with the
 * host's name and how old the reading is. When the desktop cannot supply one
 * (it is offline and nothing was received yet, or it does not serve glance at
 * all), the module says so in place instead of showing an empty reading.
 */

import { DEFAULT_GLANCE_PANEL_SETTINGS } from "@/lib/glance/presets"
import type { GlanceSnapshotV1 } from "@/lib/glance/snapshot"
import type {
  GlanceMobileEntry,
  GlanceMobileSettings,
  GlanceModuleId,
  GlancePanelSettings,
} from "@/types/glance/layout"

import type { GlancePhoneState } from "./phone-store"
import { isGlanceHostModule, type GlanceHostModuleId } from "./types"

export type GlanceModuleOrigin =
  /** Built on the desktop and received here. `live` is false once the lease dropped. */
  | { kind: "host"; host: string | null; at: number; live: boolean }
  /** The desktop could not supply it. */
  | { kind: "unavailable"; reason: "host-offline" | "host-unsupported" }

export interface PhoneGlanceLink {
  /** This phone renders a paired desktop's data. */
  paired: boolean
  /**
   * The desktop advertises glance: true, false, or null while its feature
   * manifest has not arrived.
   */
  supported: boolean | null
  remote: GlancePhoneState
}

/** Where module `id`'s data comes from on this phone. Null means "this device", or still loading. */
export function phoneOriginOf(
  id: GlanceModuleId,
  link: PhoneGlanceLink
): GlanceModuleOrigin | null {
  if (!link.paired || !isGlanceHostModule(id)) return null
  if (link.supported === false || link.remote.status === "unsupported") {
    return { kind: "unavailable", reason: "host-unsupported" }
  }
  const slice = link.remote.snapshot?.[id] ?? null
  if (slice !== null && link.remote.receivedAt !== null) {
    return {
      kind: "host",
      host: link.remote.hostLabel,
      at: link.remote.receivedAt,
      live: link.remote.status === "live",
    }
  }
  if (link.remote.status === "offline") return { kind: "unavailable", reason: "host-offline" }
  return null
}

/** The phone's snapshot: local slices, with the desktop's in place of the host-sourced ones when paired. */
export function mergePhoneSnapshot(
  local: GlanceSnapshotV1,
  remote: GlanceSnapshotV1 | null,
  paired: boolean
): GlanceSnapshotV1 {
  if (!paired) return local
  const take = <K extends GlanceHostModuleId>(id: K): GlanceSnapshotV1[K] =>
    (remote?.[id] ?? null) as GlanceSnapshotV1[K]
  return {
    ...local,
    fleet: take("fleet"),
    usage: take("usage"),
    quota: take("quota"),
    agenda: take("agenda"),
    activity: take("activity"),
    pet: take("pet"),
  }
}

/** The modules a surface needs right now: every visible one with the drawer open, else the pinned ones. */
export function neededEntries(
  entries: readonly GlanceMobileEntry[],
  drawerOpen: boolean
): GlanceMobileEntry[] {
  return entries.filter((entry) => !entry.hidden && (drawerOpen || entry.home))
}

/**
 * The layout the phone's own sources build from: the needed modules, minus
 * the ones the desktop supplies when paired, with the phone's scope and
 * options. Width, height and the delegate bar are desktop-panel settings and
 * keep their defaults.
 */
export function phoneLocalConfig(
  settings: GlanceMobileSettings,
  needed: readonly GlanceMobileEntry[],
  paired: boolean
): GlancePanelSettings {
  const on = new Set(
    needed.filter((entry) => !(paired && isGlanceHostModule(entry.id))).map((entry) => entry.id)
  )
  return {
    ...DEFAULT_GLANCE_PANEL_SETTINGS,
    preset: settings.preset,
    entries: settings.entries.map(({ id, size }) => ({ id, size, hidden: !on.has(id) })),
    scope: settings.scope,
    options: settings.options,
  }
}

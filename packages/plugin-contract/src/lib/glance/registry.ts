/**
 * The glance module catalogue (ADR-0225 §2).
 *
 * One entry per module: which sizes it renders, which snapshot slice it reads,
 * whether the workspace filter applies to it, and which surface owns its
 * subject. The owner is part of the contract, not decoration: a glance module
 * summarizes and routes, and the owner is where a click lands and where every
 * real control stays (§1). Icons are lucide names resolved by the renderer, so
 * this file stays pure and importable from anywhere.
 */

import {
  GLANCE_MODULE_IDS,
  type GlanceModuleId,
  type GlanceModuleSize,
} from "../../types/glance/layout"

/** Where a glance surface renders. */
export type GlancePlatform = "desktop" | "mobile"

/** Where a module's subject is owned. Resolved to a route by the publisher. */
export type GlanceOwnerSurface =
  | "fleet"
  | "workflows"
  | "usage"
  | "subscription"
  | "scheduler"
  | "notifications"
  | "connectivity"
  | "conversations"
  | "pet"
  | "tray-actions"

/**
 * The snapshot slice a module reads. `quick` reads the host's own action list:
 * the tray panel's action catalogue on the desktop, the shortcut list of the
 * phone's layout on a phone. Neither crosses to the other platform.
 */
export type GlanceSliceKey =
  "fleet" | "usage" | "quota" | "agenda" | "activity" | "recents" | "pet" | "actions"

export interface GlanceModuleDefinition {
  id: GlanceModuleId
  /** i18n key, under the `glance` namespace. */
  labelKey: string
  /** lucide icon name. */
  icon: string
  /** Supported sizes, smallest first. The first is the fallback. */
  sizes: readonly GlanceModuleSize[]
  slice: GlanceSliceKey
  owner: GlanceOwnerSurface
  /** Narrowed by the header's workspace filter (§8). */
  scopeable: boolean
  /** Surfaces that can render it. */
  platforms: readonly GlancePlatform[]
}

const EVERYWHERE: readonly GlancePlatform[] = ["desktop", "mobile"]

export const GLANCE_MODULES: Readonly<Record<GlanceModuleId, GlanceModuleDefinition>> = {
  fleet: {
    id: "fleet",
    labelKey: "modules.fleet.label",
    icon: "radar",
    sizes: ["compact", "standard", "expanded"],
    slice: "fleet",
    owner: "fleet",
    scopeable: false,
    platforms: EVERYWHERE,
  },
  usage: {
    id: "usage",
    labelKey: "modules.usage.label",
    icon: "chart-no-axes-column",
    sizes: ["compact", "standard", "expanded"],
    slice: "usage",
    owner: "usage",
    scopeable: true,
    platforms: EVERYWHERE,
  },
  quota: {
    id: "quota",
    labelKey: "modules.quota.label",
    icon: "gauge",
    sizes: ["compact", "standard", "expanded"],
    slice: "quota",
    owner: "subscription",
    scopeable: false,
    platforms: EVERYWHERE,
  },
  agenda: {
    id: "agenda",
    labelKey: "modules.agenda.label",
    icon: "calendar-clock",
    sizes: ["compact", "standard"],
    slice: "agenda",
    owner: "scheduler",
    scopeable: false,
    platforms: EVERYWHERE,
  },
  activity: {
    id: "activity",
    labelKey: "modules.activity.label",
    icon: "grid-3x3",
    sizes: ["compact", "standard", "expanded"],
    slice: "activity",
    owner: "usage",
    scopeable: true,
    platforms: EVERYWHERE,
  },
  quick: {
    id: "quick",
    labelKey: "modules.quick.label",
    icon: "zap",
    sizes: ["compact", "standard"],
    slice: "actions",
    owner: "tray-actions",
    scopeable: false,
    platforms: EVERYWHERE,
  },
  recents: {
    id: "recents",
    labelKey: "modules.recents.label",
    icon: "history",
    sizes: ["compact", "standard"],
    slice: "recents",
    owner: "conversations",
    scopeable: true,
    platforms: EVERYWHERE,
  },
  pet: {
    id: "pet",
    labelKey: "modules.pet.label",
    icon: "heart",
    sizes: ["compact", "standard"],
    slice: "pet",
    owner: "pet",
    scopeable: false,
    platforms: EVERYWHERE,
  },
}

/** The definition for an id, or `null` for an id this build does not know. */
export function glanceModule(id: string): GlanceModuleDefinition | null {
  return Object.prototype.hasOwnProperty.call(GLANCE_MODULES, id)
    ? GLANCE_MODULES[id as GlanceModuleId]
    : null
}

/** The modules a platform can show, in catalogue order. */
export function glanceModulesFor(platform: GlancePlatform): GlanceModuleId[] {
  return GLANCE_MODULE_IDS.filter((id) => GLANCE_MODULES[id].platforms.includes(platform))
}

/** Whether `size` is one the module renders. */
export function supportsSize(id: GlanceModuleId, size: GlanceModuleSize): boolean {
  return GLANCE_MODULES[id].sizes.includes(size)
}

/**
 * The size a module actually renders for a requested one: the request when
 * supported, else the largest supported size not above it, else the smallest.
 * A stored `expanded` on a module that tops out at `standard` degrades to
 * `standard` rather than snapping all the way down to one line.
 */
export function effectiveSize(id: GlanceModuleId, size: GlanceModuleSize): GlanceModuleSize {
  return effectiveSizeIn(GLANCE_MODULES[id].sizes, size)
}

/**
 * {@link effectiveSize} over any size list: a plugin module's declared sizes
 * (ADR-0225 §6), which only the live catalogue knows.
 */
export function effectiveSizeIn(
  sizes: readonly GlanceModuleSize[],
  size: GlanceModuleSize
): GlanceModuleSize {
  if (sizes.length === 0) return size
  if (sizes.includes(size)) return size
  const order: GlanceModuleSize[] = ["compact", "standard", "expanded"]
  const want = order.indexOf(size)
  for (let i = want; i >= 0; i -= 1) {
    if (sizes.includes(order[i])) return order[i]
  }
  return sizes[0]
}

"use client"

/**
 * Render a glance layout: the visible entries, in order, one column,
 * hairline-separated (ADR-0225 §2, §3).
 *
 * Every first-party module has a default renderer here except `quick`, whose
 * content is the host's own action catalogue (the tray panel's actions on the
 * desktop). A host passes it through `renderers`; a host that does not have
 * one simply never shows that module, and says so in its editor.
 */

import type { ComponentType } from "react"

import { effectiveSize } from "@/lib/glance/registry"
import type { GlanceLayoutEntry, GlanceModuleId, GlanceModuleSize } from "@/types/glance/layout"
import { cn } from "@/lib/utils"

import { GlanceActivityModule } from "./modules/glance-activity-module"
import { GlanceAgendaModule } from "./modules/glance-agenda-module"
import { GlanceFleetModule } from "./modules/glance-fleet-module"
import { GlancePetModule } from "./modules/glance-pet-module"
import { GlanceQuotaModule } from "./modules/glance-quota-module"
import { GlanceRecentsModule } from "./modules/glance-recents-module"
import { GlanceUsageModule } from "./modules/glance-usage-module"

export type GlanceModuleRenderer = ComponentType<{ size: GlanceModuleSize }>

export const DEFAULT_GLANCE_RENDERERS: Partial<Record<GlanceModuleId, GlanceModuleRenderer>> = {
  fleet: GlanceFleetModule,
  usage: GlanceUsageModule,
  quota: GlanceQuotaModule,
  agenda: GlanceAgendaModule,
  activity: GlanceActivityModule,
  recents: GlanceRecentsModule,
  pet: GlancePetModule,
}

export interface GlanceStackProps {
  entries: readonly GlanceLayoutEntry[]
  renderers?: Partial<Record<GlanceModuleId, GlanceModuleRenderer>>
  className?: string
}

export function GlanceStack({ entries, renderers, className }: GlanceStackProps) {
  const table = { ...DEFAULT_GLANCE_RENDERERS, ...renderers }
  return (
    <div
      data-testid="glance-stack"
      className={cn("flex flex-col divide-y divide-border", className)}
    >
      {entries
        .filter((entry) => !entry.hidden && table[entry.id])
        .map((entry) => {
          const Module = table[entry.id] as GlanceModuleRenderer
          return <Module key={entry.id} size={effectiveSize(entry.id, entry.size)} />
        })}
    </div>
  )
}

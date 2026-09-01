"use client"

/**
 * `/squads`, the Squad fleet.
 *
 * Deep links arrive as `?id=`, read through `useSearchParams()` inside a
 * `<Suspense>` boundary, not as a dynamic `[id]` route: this app is a static
 * export (Tauri + Capacitor consume `out/`), where dynamic segments do not
 * exist at runtime. Same idiom as `app/issues/page.tsx` and
 * `app/servers/detail/page.tsx`.
 *
 * The compact switch is the pattern every peer console uses (`/devices`,
 * `/issues`, `/templates`, `/servers`, and ten more). `/squads` was the only
 * one missing it, answering a phone from a `useIsMobile()` branch inside the
 * desktop component instead. `usePlatform()` decides what a surface may DO.
 * `useCompactLayout()` decides what it LOOKS like, and this is the second.
 */

import { Suspense } from "react"

import { SquadFleetConsole } from "@/components/squads/squad-fleet-console"
import { SquadsMobileBody } from "@/components/mobile/squads/squads-mobile-body"
import { useSquadRouteState } from "@/hooks/squads/use-squad-route-state"
import { useCompactLayout } from "@/hooks/ui/use-compact-layout"

function SquadsPageInner() {
  const route = useSquadRouteState()
  const compact = useCompactLayout()
  return compact ? <SquadsMobileBody route={route} /> : <SquadFleetConsole route={route} />
}

export default function SquadsPage() {
  return (
    <Suspense fallback={null}>
      <SquadsPageInner />
    </Suspense>
  )
}

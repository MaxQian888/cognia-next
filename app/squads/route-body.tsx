"use client"

import { SquadFleetConsole } from "@/components/squads/squad-fleet-console"
import { SquadsMobileBody } from "@/components/mobile/squads/squads-mobile-body"
import type { SquadRouteState } from "@/hooks/squads/use-squad-route-state"
import { useCompactLayout } from "@/hooks/ui/use-compact-layout"

export interface RouteBodyProps {
  route: SquadRouteState
}
export default function RouteBody(props: RouteBodyProps) {
  const compact = useCompactLayout()
  return compact ? <SquadsMobileBody {...props} /> : <SquadFleetConsole {...props} />
}

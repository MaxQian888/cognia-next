"use client"

/**
 * Agent-Fleet route — the cross-platform (mobile / companion-browser) view of
 * the desktop's live agent fleet. Reached from the mobile home quick-actions;
 * the desktop uses the frameless island window (`app/island`) instead.
 */

import { MobileFleetScreen } from "@/components/mobile/fleet/mobile-fleet-screen"

export default function FleetPage() {
  return <MobileFleetScreen />
}

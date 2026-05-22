"use client"

/**
 * Mobile-native terminal page. Wraps `<MobileTerminalScreen>` so the
 * `/me/terminal` route can be statically exported and consumed by the
 * Capacitor mobile shell. The screen owns its own header/back/new
 * affordance — this page just mounts it.
 */

import { MobileTerminalScreen } from "@/components/mobile/mobile-terminal-screen"

export default function MeTerminalPage() {
  return <MobileTerminalScreen />
}

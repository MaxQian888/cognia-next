/**
 * /pair — Capacitor mobile onboarding (M3.4 stub).
 *
 * The real QR-scan UX ships in M4.5 (issue #49). This stub exists to
 * exercise the full pair-flow end-to-end: HTTP POST to
 * /api/v1/auth/pair → device JWT in SecureStorage → smoke RPC + WS event.
 *
 * Server component entry — keeps page.tsx free of `"use client"` so the
 * static export build (`output: "export"`) can render a shell. Actual
 * pair logic lives in the client component.
 */

import { PairOnboardingClient } from "@/components/mobile/pair-onboarding-client"

export const dynamicParams = false

export default function MobilePairPage() {
  return <PairOnboardingClient />
}

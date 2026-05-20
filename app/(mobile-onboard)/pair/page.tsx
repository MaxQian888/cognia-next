/**
 * /pair — Capacitor mobile onboarding.
 *
 * Drives the full pair flow: LAN scan / QR / 6-digit numeric code →
 * `POST /api/v1/auth/pair` (or `/redeem-code`) → device JWT in
 * SecureStorage → smoke RPC + WS event. The actual stepper UX +
 * client-side state machine lives in `PairOnboardingClient`.
 *
 * Server component entry — keeps page.tsx free of `"use client"` so the
 * static export build (`output: "export"`) can render a shell.
 */

import { PairOnboardingClient } from "@/components/mobile/pair-onboarding-client"

export const dynamicParams = false

export default function MobilePairPage() {
  return <PairOnboardingClient />
}

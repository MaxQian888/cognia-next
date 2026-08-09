/**
 * /pair — Capacitor mobile onboarding.
 *
 * Drives the canonical pair flow: LAN discovery plus cgnp3 QR/manual input →
 * P-256 device + signaling registration → private identities in Browser
 * Vault/native secure storage → DPoP RPC and single-use-ticket WS events. The actual stepper UX +
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

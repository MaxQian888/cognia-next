/**
 * /onboarding — the first-run flow (ADR-0122).
 *
 * Replaces the modal that used to live inside the chat shells. A route rather
 * than a dialog because the flow needs room the old `max-w-xl` AlertDialog did
 * not have (a persistent rail, a machine scan, a card grid) and, more
 * importantly, because a dialog's Esc / click-outside meant "dismissed
 * forever" — the flow now has real exit semantics that record *why*.
 *
 * The app is a static export, so there is no middleware to guard this route.
 * `OnboardingGate` (mounted in `app/layout.tsx`) does the routing client-side
 * once settings and the session count have settled.
 *
 * Server-component entry — keeps this file free of `"use client"` so the
 * static export build renders a shell.
 */

import { OnboardingFlow } from "@/components/onboarding/flow"

export const dynamicParams = false

export default function OnboardingPage() {
  return <OnboardingFlow />
}

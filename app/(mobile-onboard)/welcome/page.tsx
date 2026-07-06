/**
 * /welcome — Capacitor mobile onboarding mode chooser.
 *
 * The first screen an unpaired phone sees: pick standalone (BYOK, in-webview
 * inference) or pair with a Cognia desktop. Choice persists device-local and
 * CompanionBootProvider routes off it. Server-component entry keeps page.tsx
 * free of `"use client"` so the static export (`output: "export"`) renders a
 * shell.
 */

import { ModeChooser } from "@/components/mobile/welcome/mode-chooser"

export const dynamicParams = false

export default function MobileWelcomePage() {
  return <ModeChooser />
}

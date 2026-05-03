"use client"

import { Suspense } from "react"
import { SettingsShell } from "@/components/settings/settings-shell"

export default function SettingsPage() {
  return (
    <Suspense fallback={null}>
      <SettingsShell />
    </Suspense>
  )
}

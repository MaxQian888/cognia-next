"use client"

import { Suspense } from "react"
import { SettingsShell } from "@/components/settings/settings-shell"
import { SettingsActionsMenu } from "@/components/settings/actions/settings-actions-menu"

export default function SettingsPage() {
  return (
    <Suspense fallback={null}>
      <SettingsShell actions={<SettingsActionsMenu />} />
    </Suspense>
  )
}

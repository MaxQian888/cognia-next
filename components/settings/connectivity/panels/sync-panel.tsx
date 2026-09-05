"use client"

/**
 * Connectivity → Sync: per-table mirror state. A power-user surface, which is
 * why it is the last topic rather than a collapsed group at the bottom of a
 * long page.
 */

import { SettingsStack } from "@/components/settings/common/settings-block"
import { SyncStatusCard } from "@/components/settings/companion/sync-status-card"

export function SyncPanel() {
  return (
    <SettingsStack>
      <SyncStatusCard />
    </SettingsStack>
  )
}

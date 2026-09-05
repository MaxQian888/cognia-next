"use client"

/**
 * Connectivity → Push: the credentials, and the button that proves them.
 */

import { useState } from "react"

import { SettingsStack } from "@/components/settings/common/settings-block"

import { PushCredentialsBlock, type PushConfigStatus } from "../blocks/push-credentials-block"
import { PushTestBlock } from "../blocks/push-test-block"

export function PushPanel() {
  const [status, setStatus] = useState<PushConfigStatus | null>(null)
  const configured = Boolean(status?.fcmConfigured || status?.apnsConfigured)
  return (
    <SettingsStack>
      <PushCredentialsBlock onStatus={setStatus} />
      <PushTestBlock configured={configured} />
    </SettingsStack>
  )
}

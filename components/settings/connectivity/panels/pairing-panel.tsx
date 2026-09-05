"use client"

/**
 * Connectivity → Pairing: minting the invitation a device redeems, and the
 * devices that already did.
 *
 * The browser enrollment sits under pairing rather than reachability because
 * it mints a one-shot credential, which is a pairing act. The device list
 * itself lives in `/devices`, where a device is more than a row.
 */

import { useLiveQuery } from "dexie-react-hooks"

import { DeviceConsoleLink } from "@/components/devices/device-console-link"
import { SettingsStack } from "@/components/settings/common/settings-block"
import { BrowserCompanionCard } from "@/components/settings/companion/browser-companion-card"
import { listPairedDevices } from "@/lib/db/paired-devices"

import { PairInvitationBlock } from "../blocks/pair-invitation-block"

export function PairingPanel() {
  const devices = useLiveQuery(() => listPairedDevices(), [], [])
  return (
    <SettingsStack>
      <PairInvitationBlock />
      <BrowserCompanionCard />
      <DeviceConsoleLink surface="paired" count={devices?.length ?? 0} />
    </SettingsStack>
  )
}

"use client"

/**
 * Connectivity → Cloud & relay: how this Host is reached from outside its LAN.
 *
 * The relay first, because since ADR-0170 it is the route that works from
 * anywhere with nothing installed. The tunnel is the older answer and stays
 * for hosts that want a public HTTPS name. Sign-in comes before the
 * collaboration server on purpose: the plane needs the person before it needs
 * the address.
 */

import { SettingsStack } from "@/components/settings/common/settings-block"
import { CollaborationCard } from "@/components/settings/companion/collaboration-card"
import { LogtoLoginCard } from "@/components/settings/companion/logto-login-card"
import { RemoteBrowserCard } from "@/components/settings/companion/remote-browser-card"
import { WebRtcCard } from "@/components/settings/companion/webrtc-card"

import { TunnelBlock } from "../blocks/tunnel-block"

export function CloudRelayPanel() {
  return (
    <SettingsStack>
      <WebRtcCard />
      <TunnelBlock />
      <RemoteBrowserCard />
      <LogtoLoginCard />
      <CollaborationCard />
    </SettingsStack>
  )
}

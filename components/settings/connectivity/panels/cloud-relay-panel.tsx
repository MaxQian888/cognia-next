"use client"

/**
 * Connectivity → Cloud & relay: how this Host is reached from outside its LAN.
 *
 * One sentence first: can a device away from this network reach this Host,
 * and by which route. Then the proof for the relay (a live probe of the
 * rendezvous), the relay's own configuration, the tunnel, and the overlay
 * network. The relay leads because since ADR-0170 it is the route that works
 * from anywhere with nothing installed. The tunnel is the older answer and
 * stays for hosts that want a public HTTPS name. The overlay network is the
 * third-party answer for a Host that must not be on the public internet at
 * all. Sign-in comes before the collaboration server on purpose: the plane
 * needs the person before it needs the address.
 */

import { SettingsStack } from "@/components/settings/common/settings-block"
import { CollaborationCard } from "@/components/settings/companion/collaboration-card"
import { LogtoLoginCard } from "@/components/settings/companion/logto-login-card"
import { RemoteBrowserCard } from "@/components/settings/companion/remote-browser-card"
import { WebRtcCard } from "@/components/settings/companion/webrtc-card"
import { useRemoteAccess } from "@/hooks/connectivity/use-remote-access"

import { MeshBlock } from "../blocks/mesh-block"
import { RelayCheckBlock } from "../blocks/relay-check-block"
import { RemoteAccessSummary } from "../blocks/remote-access-summary"
import { TunnelBlock } from "../blocks/tunnel-block"

export function CloudRelayPanel() {
  const access = useRemoteAccess()
  return (
    <SettingsStack>
      <RemoteAccessSummary
        isHost={access.isHost}
        relay={access.relay.route}
        tunnel={access.tunnel}
        mesh={access.mesh}
      />
      <RelayCheckBlock relay={access.relay} />
      <WebRtcCard />
      <TunnelBlock />
      <MeshBlock mesh={access.mesh} />
      <RemoteBrowserCard />
      <LogtoLoginCard />
      <CollaborationCard />
    </SettingsStack>
  )
}

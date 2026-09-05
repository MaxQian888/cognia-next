"use client"

/**
 * Connectivity → Local host: everything about how THIS machine answers.
 *
 * The channel matrix leads because it is the question the blocks below only
 * answer between them: which routes does this Host actually answer on. Browser
 * access sits here and not under Cloud & relay because it is how a browser on
 * this machine reaches the Host, and it is the only door a tab has.
 */

import { SettingsStack } from "@/components/settings/common/settings-block"
import { BrowserAccessCard } from "@/components/settings/companion/browser-access-card"
import { ChannelMatrixCard } from "@/components/settings/companion/channel-matrix-card"
import { WorkspaceRootsCard } from "@/components/settings/companion/workspace-roots-card"

import { MdnsBlock } from "../blocks/mdns-block"
import { ServerBlock } from "../blocks/server-block"

export function LocalHostPanel() {
  return (
    <SettingsStack>
      <ChannelMatrixCard />
      <ServerBlock />
      <MdnsBlock />
      <BrowserAccessCard />
      <WorkspaceRootsCard />
    </SettingsStack>
  )
}

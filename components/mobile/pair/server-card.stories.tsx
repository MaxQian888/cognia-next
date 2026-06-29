import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { ServerCard } from "./server-card"
import { makeDiscoveredServer } from "@/lib/storybook/fixtures/pair"

// Tappable row for one discovered desktop. Pure: `server` drives the icon /
// badges / subtitle, `status` drives the pre-flight `/healthz` affordance
// (idle chevron → spinner → check / warning), and `mismatch` recolours the TLS
// badge. All variants below feed a fabricated `DiscoveredServer`.
const meta = {
  title: "Mobile/Pair/ServerCard",
  component: ServerCard,
  parameters: { layout: "fullscreen" },
  args: { onSelect: fn() },
  decorators: [
    (Story) => (
      <div className="mx-auto w-[390px] p-4">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ServerCard>

export default meta
type Story = StoryObj<typeof meta>

/** A currently-paired desktop surfaced via mDNS with a pinned fingerprint. */
export const Paired: Story = {
  args: { server: makeDiscoveredServer({ source: "paired", hostname: "studio-mac.local" }) },
}

/** A live mDNS hit. */
export const Mdns: Story = {
  args: { server: makeDiscoveredServer({ source: "mdns" }) },
}

/** An IP-segment probe hit with no fingerprint yet — shows the "unverified" hint. */
export const ProbeUnverified: Story = {
  args: {
    server: makeDiscoveredServer({ source: "probe", fingerprint: undefined, serverId: undefined }),
  },
}

/** A previously-seen server from history. */
export const History: Story = {
  args: { server: makeDiscoveredServer({ source: "history", latencyMs: undefined }) },
}

/** Pre-flight reachability check in flight. */
export const Checking: Story = {
  args: { server: makeDiscoveredServer(), status: "checking" },
}

/** Pre-flight succeeded — green check + result line. */
export const Reachable: Story = {
  args: {
    server: makeDiscoveredServer(),
    status: "ok",
    statusLabel: "Reachable · v1.4.2 · 24ms",
  },
}

/** Pre-flight failed — warning icon + error line. */
export const Unreachable: Story = {
  args: {
    server: makeDiscoveredServer(),
    status: "error",
    statusLabel: "Could not reach this server",
  },
}

/** Stored fingerprint disagrees with the one the server reported. */
export const FingerprintMismatch: Story = {
  args: { server: makeDiscoveredServer({ source: "paired" }), mismatch: true },
}

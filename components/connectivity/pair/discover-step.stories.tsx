import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { DiscoverStep } from "./discover-step"
import type { scanLan } from "@/lib/connectivity/lan-scanner"
import type { fetchHealthz } from "@/lib/connectivity/healthz"
import { makeDiscoveredServer } from "@/lib/storybook/fixtures/pair"

// The Discover step drives `useLanScan` on mount. In Storybook we inject a fake
// `scan` (so no real mDNS / IP-segment probing runs) and a fake `probe` (so the
// pre-flight `/healthz` check resolves deterministically). `precheckDelayMs: 0`
// keeps tapped-server selection instant.
const foundScan: typeof scanLan = async ({ onFound }) => {
  const servers = [
    makeDiscoveredServer({ source: "paired", hostname: "studio-mac.local" }),
    makeDiscoveredServer({ source: "mdns" }),
    makeDiscoveredServer({ source: "probe", fingerprint: undefined }),
  ]
  for (const s of servers) onFound(s)
  return servers
}

const emptyScan: typeof scanLan = async () => []

const okProbe: typeof fetchHealthz = async () => ({
  version: "1.4.2",
  fingerprint: "ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12",
  advertisedPort: 7890,
  serverId: "srv-1",
})

const meta = {
  title: "Mobile/Pair/DiscoverStep",
  component: DiscoverStep,
  parameters: { layout: "fullscreen" },
  args: {
    onSelect: fn(),
    onSkip: fn(),
    onScanShortcut: fn(),
    probe: okProbe,
    precheckDelayMs: 0,
  },
  decorators: [
    (Story) => (
      <div className="mx-auto h-[760px] w-[390px] overflow-y-auto p-4">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof DiscoverStep>

export default meta
type Story = StoryObj<typeof meta>

/** Scan surfaced a paired desktop plus two nearby servers. */
export const ServersFound: Story = {
  args: { scan: foundScan },
}

/** Scan settled with nothing — empty state + auto-expanded help. */
export const NothingFound: Story = {
  args: { scan: emptyScan },
}

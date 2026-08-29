import type { Meta, StoryObj } from "@storybook/nextjs"

import { SiteMobileOverview } from "./site-mobile-overview"
import { makeDeployment, makeSite } from "@/lib/storybook/fixtures/sites"

// ADR-0084 defers the mobile projection, so nothing here reaches another host.
// What it can do is read this device's own database and say so — the previous
// screen was one "desktop only" card that could not tell you whether the phone
// knew about any Sites at all.
const meta = {
  title: "Sites/SiteMobileOverview",
  component: SiteMobileOverview,
  args: {
    sites: [makeSite(), makeSite({ id: "site_marketing", name: "Marketing" })],
    activeDeployments: [makeDeployment()],
    loading: false,
  },
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <div className="w-[390px] border-x">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof SiteMobileOverview>

export default meta
type Story = StoryObj<typeof meta>

export const WithLocalSites: Story = {}

/** The common case: says why, and where the Sites actually live. */
export const NothingOnThisDevice: Story = {
  args: { sites: [], activeDeployments: [] },
}

export const Loading: Story = { args: { sites: [], activeDeployments: [], loading: true } }

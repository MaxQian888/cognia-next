import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { SiteListRail } from "./site-list-rail"
import { makeDeployment, makeOperation, makeSite } from "@/lib/storybook/fixtures/sites"

// The console's rail. Each row has to answer "is this one live, busy, or
// broken" without being selected, which is why the console loads cross-Site
// deployment and operation signals alongside the selection.
const meta = {
  title: "Sites/SiteListRail",
  component: SiteListRail,
  args: {
    sites: [
      makeSite(),
      makeSite({ id: "site_marketing", name: "Marketing" }),
      makeSite({ id: "site_old", name: "Legacy", lifecycle: "taken-down" }),
    ],
    selectedId: "site_docs",
    loading: false,
    activeDeployments: [makeDeployment()],
    operationSignals: [makeOperation({ siteId: "site_marketing", status: "running" })],
    onSelect: fn(),
  },
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <div className="h-[560px] w-[300px] border-r">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof SiteListRail>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

/** Skeletons, not an empty state: the two must not paint the same thing. */
export const Loading: Story = { args: { sites: [], loading: true } }

export const NoSitesYet: Story = { args: { sites: [], activeDeployments: [] } }

/** A Site whose last operation failed and which has never served traffic. */
export const Broken: Story = {
  args: {
    sites: [makeSite({ id: "site_broken", name: "Blog" })],
    selectedId: "site_broken",
    activeDeployments: [],
    operationSignals: [makeOperation({ siteId: "site_broken", status: "failed" })],
  },
}

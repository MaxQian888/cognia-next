import type { Meta, StoryObj } from "@storybook/nextjs"

import { SiteHeroStats } from "./site-hero-stats"
import {
  makeDeployment,
  makeOperationSet,
  makeResourceSet,
  makeVersionSet,
} from "@/lib/storybook/fixtures/sites"

// Column count follows the data: `buildSiteStats` returns only what a Site can
// answer, because an empty tile reads as a value that failed to load.
const meta = {
  title: "Sites/SiteHeroStats",
  component: SiteHeroStats,
  args: {
    versions: makeVersionSet(),
    deployments: [makeDeployment()],
    operations: makeOperationSet(),
    resources: makeResourceSet(),
  },
  decorators: [
    (Story) => (
      <div className="@container/site-pane w-full max-w-3xl p-4">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof SiteHeroStats>

export default meta
type Story = StoryObj<typeof meta>

export const Everything: Story = {}

/** A Site that has only ever built: three stats, three columns. */
export const JustBuilt: Story = {
  args: { deployments: [], operations: [], resources: [] },
}

/** Nothing to say yet — the strip renders nothing rather than zeros. */
export const Nothing: Story = {
  args: { versions: [], deployments: [], operations: [], resources: [] },
}

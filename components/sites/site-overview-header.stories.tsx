import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { SiteOverviewHeader } from "./site-overview-header"
import {
  ALLOWED_GATE,
  BLOCKED_GATE,
  makeDeployment,
  makeOperationSet,
  makeResourceSet,
  makeSite,
  makeVersionSet,
} from "@/lib/storybook/fixtures/sites"

// The persistent header: the production URL (which nothing rendered for a long
// time), the stat strip, and the failure banner that used to be a vanished
// toast.
const meta = {
  title: "Sites/SiteOverviewHeader",
  component: SiteOverviewHeader,
  args: {
    site: makeSite(),
    versions: makeVersionSet(),
    deployments: [makeDeployment()],
    operations: makeOperationSet(),
    resources: makeResourceSet(),
    actorAccountId: "owner",
    gate: ALLOWED_GATE,
    metadataGate: ALLOWED_GATE,
    isBusy: () => false,
    onTakeDown: fn(),
    onRestore: fn(),
    onPurge: fn(),
    onDeleteMetadata: fn(),
  },
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <div className="@container/site-pane w-full max-w-4xl">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof SiteOverviewHeader>

export default meta
type Story = StoryObj<typeof meta>

export const Live: Story = {}

/** Nothing published yet: the URL slot holds its place and explains itself. */
export const NeverDeployed: Story = {
  args: { deployments: [], operations: [], versions: [] },
}

/** A viewer sees the Site and every mutating control disabled with a reason. */
export const AsViewer: Story = {
  args: { actorAccountId: "stranger", gate: BLOCKED_GATE, metadataGate: BLOCKED_GATE },
}

export const TakenDown: Story = {
  args: { site: makeSite({ lifecycle: "taken-down" }), deployments: [] },
}

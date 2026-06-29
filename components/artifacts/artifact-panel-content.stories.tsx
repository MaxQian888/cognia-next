import type { Meta, StoryObj } from "@storybook/nextjs"

import { ArtifactPanelContent } from "./artifact-panel-content"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { useArtifactStore } from "@/stores/artifact/artifact-store"
import { makeArtifact } from "@/lib/storybook/fixtures/artifacts"

const artifact = makeArtifact()

function seedActiveArtifact() {
  resetStore(useArtifactStore)
  seedStore(useArtifactStore, {
    artifacts: { [artifact.id]: artifact },
    activeArtifactId: artifact.id,
    panelOpen: true,
    panelView: "artifact",
  })
}

// The shared body of the artifacts surface (used by both the Sheet and the
// docked panel). With an active artifact it shows the header + code view; with
// none it falls back to the recent-artifacts list.
const meta = {
  title: "Artifacts/ArtifactPanelContent",
  component: ArtifactPanelContent,
  args: { panelMode: "desktop" },
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <div className="flex h-[600px] w-[520px] flex-col border">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ArtifactPanelContent>

export default meta
type Story = StoryObj<typeof meta>

export const WithArtifact: Story = {
  beforeEach: () => seedActiveArtifact(),
}

export const EmptyRecentList: Story = {
  beforeEach: () => {
    resetStore(useArtifactStore)
  },
}

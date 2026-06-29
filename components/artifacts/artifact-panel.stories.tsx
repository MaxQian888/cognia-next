import type { Meta, StoryObj } from "@storybook/nextjs"

import { ArtifactPanel } from "./artifact-panel"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { useArtifactStore } from "@/stores/artifact/artifact-store"
import { makeArtifact } from "@/lib/storybook/fixtures/artifacts"

const artifact = makeArtifact()

// The Sheet (offcanvas) host for the artifacts surface — the mobile/tablet
// fallback. The Sheet is only open when `panelOpen && panelView === "artifact"`,
// so the Open story seeds both plus an active artifact.
const meta = {
  title: "Artifacts/ArtifactPanel",
  component: ArtifactPanel,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof ArtifactPanel>

export default meta
type Story = StoryObj<typeof meta>

export const Open: Story = {
  beforeEach: () => {
    resetStore(useArtifactStore)
    seedStore(useArtifactStore, {
      artifacts: { [artifact.id]: artifact },
      activeArtifactId: artifact.id,
      panelOpen: true,
      panelView: "artifact",
    })
  },
}

// Closed panel → the Sheet renders nothing visible.
export const Closed: Story = {
  beforeEach: () => {
    resetStore(useArtifactStore)
  },
}

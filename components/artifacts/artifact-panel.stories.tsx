import type { Meta, StoryObj } from "@storybook/nextjs"

import { ArtifactPanel } from "./artifact-panel"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { useArtifactStore } from "@/stores/artifact/artifact-store"
import { useArtifactDockLayoutStore } from "@/stores/artifact/artifact-dock-layout-store"
import { useChatStore } from "@/stores/chat"
import { makeArtifact } from "@/lib/storybook/fixtures/artifacts"

const artifact = makeArtifact()

// The Sheet (offcanvas) host for the artifacts surface — the mobile/tablet
// fallback. Visibility comes from `mobileSheetOpen` (the layout store), which is
// the one field every reveal writes and the only one that can see
// `userDismissed`, so the Open story raises that plus an active artifact.
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
    resetStore(useArtifactDockLayoutStore)
    seedStore(useChatStore, { activeSessionId: artifact.sessionId })
    seedStore(useArtifactStore, {
      artifacts: { [artifact.id]: artifact },
      activeArtifactIdBySession: { [artifact.sessionId]: artifact.id },
      panelOpen: true,
      panelView: "artifact",
    })
    seedStore(useArtifactDockLayoutStore, { mobileSheetOpen: true })
  },
}

// Closed panel → the Sheet renders nothing visible.
export const Closed: Story = {
  beforeEach: () => {
    resetStore(useArtifactStore)
    resetStore(useArtifactDockLayoutStore)
  },
}

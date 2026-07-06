import type { Meta, StoryObj } from "@storybook/nextjs"

import { ArtifactDock } from "./artifact-dock"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { useArtifactStore } from "@/stores/artifact/artifact-store"
import { useArtifactDockLayoutStore } from "@/stores/artifact/artifact-dock-layout-store"
import { makeArtifact, makeArtifactList } from "@/lib/storybook/fixtures/artifacts"

const SESSION = "ses_1"
const artifact = makeArtifact({ sessionId: SESSION })

function seedDock(listRailOpen: boolean) {
  resetStore(useArtifactStore)
  resetStore(useArtifactDockLayoutStore)
  const list = makeArtifactList(SESSION)
  seedStore(useArtifactStore, {
    artifacts: Object.fromEntries([...list, artifact].map((a) => [a.id, a])),
    activeArtifactId: artifact.id,
    artifactWorkspace: {
      scope: "session",
      sessionId: SESSION,
      searchQuery: "",
      typeFilter: "all",
      runtimeFilter: "all",
      recentArtifactIds: [],
      returnContext: null,
    },
  })
  seedStore(useArtifactDockLayoutStore, { listRailOpen })
}

// The docked (non-modal) artifacts surface for the desktop right rail: a slim
// header (collapse + history-rail toggle) wrapping the shared panel content.
const meta = {
  title: "Artifacts/ArtifactDock",
  component: ArtifactDock,
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <div className="flex h-[600px] w-[560px]">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ArtifactDock>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  beforeEach: () => seedDock(false),
}

export const WithHistoryRail: Story = {
  beforeEach: () => seedDock(true),
}

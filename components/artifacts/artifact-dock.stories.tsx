import type { Meta, StoryObj } from "@storybook/nextjs"

import { ArtifactDock } from "./artifact-dock"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { useArtifactStore } from "@/stores/artifact/artifact-store"
import { useArtifactDockLayoutStore } from "@/stores/artifact/artifact-dock-layout-store"
import { useChatStore } from "@/stores/chat"
import { makeArtifact, makeArtifactList } from "@/lib/storybook/fixtures/artifacts"

const SESSION = "ses_1"
const artifact = makeArtifact({ sessionId: SESSION })

function seedDock(withArtifact: boolean) {
  resetStore(useArtifactStore)
  resetStore(useArtifactDockLayoutStore)
  const list = makeArtifactList(SESSION)
  // Tabs are bucketed per conversation, so the dock only sees them once a
  // conversation is on screen.
  seedStore(useChatStore, { activeSessionId: SESSION })
  seedStore(useArtifactStore, {
    artifacts: Object.fromEntries([...list, artifact].map((a) => [a.id, a])),
    activeArtifactIdBySession: withArtifact ? { [SESSION]: artifact.id } : {},
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
}

// The docked (non-modal) artifacts surface for the desktop right rail. One
// Context Workbench shell throughout; the only difference between these two
// stories is which resource backs it — an artifact, or the chat session.
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

export const ArtifactResource: Story = {
  beforeEach: () => seedDock(true),
}

export const SessionResource: Story = {
  beforeEach: () => seedDock(false),
}

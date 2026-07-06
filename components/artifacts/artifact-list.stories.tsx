import type { Meta, StoryObj } from "@storybook/nextjs"

import { ArtifactList } from "./artifact-list"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { useArtifactStore } from "@/stores/artifact/artifact-store"
import { makeArtifactList } from "@/lib/storybook/fixtures/artifacts"

const SESSION = "ses_1"

function seedArtifacts() {
  const artifacts = makeArtifactList(SESSION)
  seedStore(useArtifactStore, {
    artifacts: Object.fromEntries(artifacts.map((a) => [a.id, a])),
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

// Searchable / filterable list of a session's artifacts with context menus and
// a delete confirmation. Reads the artifact store; the populated story seeds a
// mixed-type session, the empty story leaves the store reset.
const meta = {
  title: "Artifacts/ArtifactList",
  component: ArtifactList,
  args: { sessionId: SESSION },
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <div className="h-[500px] w-[420px] border-r">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ArtifactList>

export default meta
type Story = StoryObj<typeof meta>

export const Populated: Story = {
  beforeEach: () => {
    resetStore(useArtifactStore)
    seedArtifacts()
  },
}

export const Empty: Story = {
  beforeEach: () => {
    resetStore(useArtifactStore)
  },
}

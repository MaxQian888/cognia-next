import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { PanelVersionHistory } from "./panel-version-history"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { useArtifactStore } from "@/stores/artifact/artifact-store"
import { makeArtifact, makeArtifactVersion } from "@/lib/storybook/fixtures/artifacts"

const artifact = makeArtifact({ version: 3 })

// Version-history panel with save / restore / inline-diff controls. Reads the
// `artifactVersions` store slice, so the populated story seeds two prior
// versions for `artifact.id`.
const meta = {
  title: "Artifacts/PanelVersionHistory",
  component: PanelVersionHistory,
  args: { artifact, onVersionRestored: fn() },
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <div className="w-[480px]">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof PanelVersionHistory>

export default meta
type Story = StoryObj<typeof meta>

export const WithVersions: Story = {
  beforeEach: () => {
    resetStore(useArtifactStore)
    seedStore(useArtifactStore, {
      artifactVersions: {
        [artifact.id]: [
          makeArtifactVersion({
            artifactId: artifact.id,
            version: 1,
            changeDescription: "Initial draft",
          }),
          makeArtifactVersion({
            artifactId: artifact.id,
            version: 2,
            changeDescription: "Add window eviction",
            content: "export function rateLimit(max) {\n  return max > 0\n}\n",
          }),
        ],
      },
    })
  },
}

export const NoVersions: Story = {
  beforeEach: () => {
    resetStore(useArtifactStore)
  },
}

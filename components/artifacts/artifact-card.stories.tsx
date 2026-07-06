import type { Meta, StoryObj } from "@storybook/nextjs"

import { ArtifactCard } from "./artifact-card"
import { resetStore } from "@/lib/storybook/seed-stores"
import { useArtifactStore } from "@/stores/artifact/artifact-store"
import { makeArtifact, makeTypedArtifact } from "@/lib/storybook/fixtures/artifacts"

// Card reference for an artifact in a message. Renders from the `artifact` prop;
// the duplicate action reads the artifact store, so reset it between stories.
const meta = {
  title: "Artifacts/ArtifactCard",
  component: ArtifactCard,
  args: { artifact: makeArtifact() },
  parameters: { layout: "padded" },
  beforeEach: () => {
    resetStore(useArtifactStore)
  },
  decorators: [
    (Story) => (
      <div className="w-96">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ArtifactCard>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

export const WithPreview: Story = {
  args: { showPreview: true },
}

export const Compact: Story = {
  args: { compact: true },
}

export const DocumentType: Story = {
  args: {
    artifact: makeTypedArtifact("document", "Design notes", "# Design notes\n\n- point one"),
    showPreview: true,
  },
}

import type { Meta, StoryObj } from "@storybook/nextjs"

import { ArtifactReviewView } from "./artifact-review-view"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { useArtifactStore } from "@/stores/artifact/artifact-store"
import { makeArtifact, makePendingReview } from "@/lib/storybook/fixtures/artifacts"

const artifact = makeArtifact()

function seedReview(over = {}) {
  resetStore(useArtifactStore)
  seedStore(useArtifactStore, {
    pendingReviews: { [artifact.id]: makePendingReview(over) },
  })
}

// Codex-style review surface for an AI-revision proposal: a diff up top, a
// per-hunk accept/reject list, and an apply/reject footer. Reads the pending
// review from the artifact store. `panelMode: "mobile"` swaps the Monaco diff
// editor for a lightweight inline diff (deterministic in Storybook).
const meta = {
  title: "Artifacts/ArtifactReviewView",
  component: ArtifactReviewView,
  args: { artifact, panelMode: "mobile" },
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <div className="flex h-[560px] w-[480px] flex-col border">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ArtifactReviewView>

export default meta
type Story = StoryObj<typeof meta>

export const InlineDiff: Story = {
  beforeEach: () => seedReview(),
}

export const Stale: Story = {
  beforeEach: () => seedReview({ isStale: true }),
}

// `panelMode: "desktop"` renders the Monaco DiffEditor side-by-side.
export const DesktopMonaco: Story = {
  args: { panelMode: "desktop" },
  decorators: [
    (Story) => (
      <div className="flex h-[640px] w-[900px] flex-col border">
        <Story />
      </div>
    ),
  ],
  beforeEach: () => seedReview(),
}

// No pending review for the artifact → the component renders nothing.
export const NoReview: Story = {
  beforeEach: () => {
    resetStore(useArtifactStore)
  },
}

import type { Meta, StoryObj } from "@storybook/nextjs"

import { TwinHeaderBadge } from "./twin-header-badge"

// Compact twin status badge for the chat header. Hovering reveals chunk /
// source counts and the RAG / few-shot toggle state. Counts read from Dexie —
// Storybook opens a fresh, empty IndexedDB, so they show 0.
const meta = {
  title: "Chat/TwinHeaderBadge",
  component: TwinHeaderBadge,
  parameters: { layout: "centered" },
  args: { twinId: "twin-alex" },
} satisfies Meta<typeof TwinHeaderBadge>

export default meta
type Story = StoryObj<typeof meta>

/** Default twin settings. Hover for the stat summary. */
export const Default: Story = {}

/** RAG + few-shot explicitly enabled via per-character overrides. */
export const RagAndFewShotOn: Story = {
  args: {
    twinSettings: { enableRag: true, ragTopK: 8, enableStyleFewShot: true, styleSamplesK: 4 },
  },
}

/** Both retrieval features disabled. */
export const FeaturesOff: Story = {
  args: { twinSettings: { enableRag: false, enableStyleFewShot: false } },
}

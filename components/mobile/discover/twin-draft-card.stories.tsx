import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { TwinDraftCard } from "./twin-draft-card"
import { makeTwinDraft } from "@/lib/storybook/fixtures/mobile-discover"

// A single distilled twin draft (character or skill) awaiting review. Pure:
// shows kind + status badges, a summary, the created date, and a quality score.
const meta = {
  title: "Mobile/Discover/TwinDraftCard",
  component: TwinDraftCard,
  parameters: { layout: "padded" },
  args: { draft: makeTwinDraft(), onSelect: fn() },
  decorators: [
    (Story) => (
      <div className="w-[360px]">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof TwinDraftCard>

export default meta
type Story = StoryObj<typeof meta>

export const CharacterDraft: Story = {}

export const SkillDraft: Story = {
  args: {
    draft: makeTwinDraft({
      kind: "skill",
      payload: {
        kind: "skill",
        data: {
          name: "Standup digest",
          description: "Summarize the team's overnight messages into 5 bullets.",
        },
      },
      evaluation: { qualityScore: 0.64, concerns: ["thin sample size"], suggestions: [] },
    }),
  },
}

export const Accepted: Story = {
  args: { draft: makeTwinDraft({ status: "accepted", acceptedAsId: "char-9" }) },
}

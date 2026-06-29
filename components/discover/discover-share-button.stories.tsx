import type { Meta, StoryObj } from "@storybook/nextjs"

import { DiscoverShareButton } from "./discover-share-button"
import type { DiscoverItem } from "@/hooks/discover/use-discover-query"

// Renders only for the portable definition kinds (character / skill / team /
// workflowTemplate); returns null for everything else. The PII gate + share
// dialog open on click.
const item = (raw: { kind: string; id: string; data: Record<string, unknown> }): DiscoverItem =>
  raw as unknown as DiscoverItem

const meta = {
  title: "Discover/DiscoverShareButton",
  component: DiscoverShareButton,
  parameters: { layout: "padded" },
} satisfies Meta<typeof DiscoverShareButton>

export default meta
type Story = StoryObj<typeof meta>

export const ShareableCharacter: Story = {
  args: {
    item: item({
      kind: "character",
      id: "c1",
      data: {
        name: "Ada",
        description: "A meticulous senior engineer persona.",
        systemPrompt: "You are Ada, a precise and helpful engineer.",
        avatarEmoji: "🧠",
      },
    }),
  },
}

export const ShareableSkill: Story = {
  args: {
    item: item({
      kind: "skill",
      id: "s1",
      data: { name: "PDF reading", description: "Extract text from PDFs.", content: "# PDF" },
    }),
  },
}

// Non-portable kind (e.g. mcpServer) → renders nothing.
export const NotShareable: Story = {
  args: {
    item: item({ kind: "mcpServer", id: "m1", data: { name: "context7" } }),
  },
  render: (args) => (
    <div className="rounded border border-dashed px-3 py-2 text-xs text-muted-foreground">
      renders nothing for non-portable kinds → <DiscoverShareButton {...args} />
    </div>
  ),
}

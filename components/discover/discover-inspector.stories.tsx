import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { DiscoverInspector } from "./discover-inspector"
import type { DiscoverItem } from "@/hooks/discover/use-discover-query"

// Right rail for the desktop discover page. No selection → per-category
// overview; a selection → focused per-kind detail panel.
const item = (raw: { kind: string; id: string; data: Record<string, unknown> }): DiscoverItem =>
  raw as unknown as DiscoverItem

const items: DiscoverItem[] = [
  item({
    kind: "character",
    id: "c1",
    data: { name: "Ada", description: "Senior engineer persona.", isBuiltIn: true },
  }),
  item({
    kind: "skill",
    id: "s1",
    data: { name: "PDF reading", description: "Extract text from PDFs.", status: "enabled" },
  }),
]

const meta = {
  title: "Discover/DiscoverInspector",
  component: DiscoverInspector,
  args: { category: "characters", itemId: null, items, onClose: fn() },
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <div className="flex h-[560px] w-80 flex-col border-l">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof DiscoverInspector>

export default meta
type Story = StoryObj<typeof meta>

export const Overview: Story = {}

export const CharacterSelected: Story = { args: { itemId: "c1" } }

export const SkillSelected: Story = { args: { category: "skills", itemId: "s1" } }

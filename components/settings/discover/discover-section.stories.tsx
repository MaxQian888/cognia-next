import type { Meta, StoryObj } from "@storybook/nextjs"

import { DiscoverSection } from "./discover-section"

// `DiscoverSection` embeds the shared `<DiscoverCustomizer/>` inline under a
// localized heading (mirrors `SidebarSection`). Propless — the customizer owns
// its own state.
const meta = {
  title: "Settings/Discover/DiscoverSection",
  component: DiscoverSection,
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <div className="max-w-3xl">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof DiscoverSection>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

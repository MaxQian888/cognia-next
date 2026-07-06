import type { Meta, StoryObj } from "@storybook/nextjs"

import { SidebarSection } from "./sidebar-section"

// `SidebarSection` is a thin wrapper that embeds the shared `<SidebarCustomizer/>`
// under a localized heading. It is propless; the customizer manages its own
// state, so the Default story exercises the full inline editing surface.
const meta = {
  title: "Settings/Sidebar/SidebarSection",
  component: SidebarSection,
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <div className="max-w-3xl">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof SidebarSection>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

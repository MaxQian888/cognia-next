import type { Meta, StoryObj } from "@storybook/nextjs"

import { ShellLayoutSection } from "./shell-layout-section"

// `ShellLayoutSection` is a thin wrapper that embeds the shared
// `<ShellLayoutCustomizer/>` under a localized heading. It is propless; the
// customizer manages its own state, so the Default story exercises all three
// tabs (sidebar / top bar / bottom bar).
const meta = {
  title: "Settings/ShellLayout/ShellLayoutSection",
  component: ShellLayoutSection,
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <div className="max-w-3xl">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ShellLayoutSection>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

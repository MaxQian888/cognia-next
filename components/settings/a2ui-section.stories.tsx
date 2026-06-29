import type { Meta, StoryObj } from "@storybook/nextjs"

import { A2UISection } from "./a2ui-section"

// `A2UISection` is the tabbed A2UI shell (Overview / Runtime / Templates / MCP
// Bridge / Debugger). The active tab is reflected in `?a2uiTab=`; with the
// router mocked the default Overview tab renders.
const meta = {
  title: "Settings/A2UISection",
  component: A2UISection,
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <div className="h-[640px] overflow-auto p-4">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof A2UISection>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

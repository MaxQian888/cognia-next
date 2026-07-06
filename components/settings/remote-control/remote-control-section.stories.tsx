import type { Meta, StoryObj } from "@storybook/nextjs"

import { RemoteControlSection } from "./remote-control-section"

// `RemoteControlSection` is a tabbed shell whose active tab is mirrored into the
// URL via the App Router. With the preview's router mocks the default tab
// renders.
const meta = {
  title: "Settings/RemoteControl/RemoteControlSection",
  component: RemoteControlSection,
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <div className="h-[640px] overflow-auto p-4">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof RemoteControlSection>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

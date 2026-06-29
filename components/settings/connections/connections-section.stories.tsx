import type { Meta, StoryObj } from "@storybook/nextjs"

import { ConnectionsSection } from "./connections-section"

// `ConnectionsSection` is a tabbed shell whose active tab is mirrored into the
// URL via the App Router. With the preview's router mocks the default tab
// renders; connector data is read from Dexie, which is empty in Storybook, so
// the tab shows its empty state.
const meta = {
  title: "Settings/Connections/ConnectionsSection",
  component: ConnectionsSection,
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <div className="h-[640px] overflow-auto p-4">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ConnectionsSection>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

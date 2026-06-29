import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { QuickAppBuilder } from "./quick-app-builder"
import { resetStore } from "@/lib/storybook/seed-stores"
import { useA2UIStore } from "@/stores/a2ui"

// QuickAppBuilder is the AI-driven mini-app authoring surface. A reset store
// shows the default Flash tab plus the template/my-apps navigation chrome.
const meta = {
  title: "A2UI/QuickAppBuilder",
  component: QuickAppBuilder,
  parameters: { layout: "fullscreen" },
  args: {
    onAction: fn(),
    onDataChange: fn(),
    onAppSelect: fn(),
  },
  beforeEach: () => {
    resetStore(useA2UIStore)
  },
  decorators: [
    (Story) => (
      <div className="h-[640px] w-full">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof QuickAppBuilder>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

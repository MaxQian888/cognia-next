import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { CustomModeEditor } from "./index"
import { resetStore } from "@/lib/storybook/seed-stores"
import { useCustomModeStore } from "@/stores/agent/custom-mode-store"
import { useMcpStore } from "@/stores/mcp/mcp-store"

const meta = {
  title: "Agent/Mode/CustomModeEditor/Editor",
  component: CustomModeEditor,
  parameters: { layout: "fullscreen" },
  args: {
    open: true,
    onOpenChange: fn(),
    onSave: fn(),
  },
  beforeEach: () => {
    resetStore(useCustomModeStore)
    resetStore(useMcpStore)
  },
} satisfies Meta<typeof CustomModeEditor>

export default meta
type Story = StoryObj<typeof meta>

// Create flow — tabs across basic / tools / advanced / AI generate.
export const NewMode: Story = {}

export const Closed: Story = {
  args: { open: false },
}

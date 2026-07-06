import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { McpPresetGrid } from "./mcp-preset-grid"

// Pure, props-only: `existingNames` greys out already-added presets and
// `onPresetSelected` fires when a preset (or its inline configure step) is
// chosen. The catalog itself comes from the static `MCP_PRESETS` import.
const meta = {
  title: "Settings/MCP/McpPresetGrid",
  component: McpPresetGrid,
  args: {
    existingNames: [],
    onPresetSelected: fn(),
  },
  decorators: [
    (Story) => (
      <div className="max-w-3xl">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof McpPresetGrid>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

// A couple of presets already installed → "added" badge + disabled tiles.
export const WithExistingServers: Story = {
  args: { existingNames: ["github", "filesystem", "postgres"] },
}

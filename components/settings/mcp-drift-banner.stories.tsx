import type { Meta, StoryObj } from "@storybook/nextjs"

import { McpDriftBanner } from "./mcp-drift-banner"

// `McpDriftBanner` warns when Cognia's projection of an MCP server drifts from
// what's actually in an external agent's config file. It reads those files
// through the Tauri runtime, so `isTauri()` gates it: in the browser preview it
// returns `null` (and it also self-hides when there's no drift). Documented here
// so the dormant-in-web behaviour is discoverable.
const meta = {
  title: "Settings/McpDriftBanner",
  component: McpDriftBanner,
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <div className="max-w-2xl">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof McpDriftBanner>

export default meta
type Story = StoryObj<typeof meta>

// Web/preview branch: renders nothing. The drift warning appears only in the
// Tauri desktop build when a managed server is missing from an agent file.
export const Default: Story = {}

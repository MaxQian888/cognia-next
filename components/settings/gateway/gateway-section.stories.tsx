import type { Meta, StoryObj } from "@storybook/nextjs"

import { GatewaySection } from "./gateway-section"

// `GatewaySection` is desktop-only (the inbound LLM gateway lives in the Tauri
// runtime). In the browser preview `isTauri()` is false, so the component takes
// its web branch and renders the "desktop only" notice — the listener controls,
// token manager, and request log are reachable only in the desktop build.
const meta = {
  title: "Settings/Gateway/GatewaySection",
  component: GatewaySection,
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <div className="max-w-2xl">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof GatewaySection>

export default meta
type Story = StoryObj<typeof meta>

// Web/preview branch: the desktop-only notice.
export const Default: Story = {}

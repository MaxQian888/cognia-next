import type { Meta, StoryObj } from "@storybook/nextjs"

import { CogniaCliStatusCard } from "./cognia-cli-status-card"

// CLI status card for the devtools pane — probes for the `cognia` CLI + dev
// bridge. The probe is desktop-only; in this browser Storybook the hook reports
// unsupported, so the card shows its desktop-only marker.

const meta = {
  title: "Plugins/Devtools/CogniaCliStatusCard",
  component: CogniaCliStatusCard,
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <div className="w-[480px] max-w-full">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof CogniaCliStatusCard>

export default meta
type Story = StoryObj<typeof meta>

// Web/browser → the desktop-only marker.
export const WebFallback: Story = {}

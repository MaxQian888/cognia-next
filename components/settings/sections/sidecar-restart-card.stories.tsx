import type { Meta, StoryObj } from "@storybook/nextjs"

import { SidecarRestartCard } from "./sidecar-restart-card"

// Tauri-branching: the 5s poll for `sidecar_restart_count` only runs under the
// desktop shell. In the Storybook browser (`isTauri()` is false) the effect
// returns early, so the card renders its static layout with the count / last-
// restart / last-checked rows showing the em-dash placeholders.
const meta = {
  title: "Settings/Sections/SidecarRestartCard",
  component: SidecarRestartCard,
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <div className="w-[480px] max-w-full">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof SidecarRestartCard>

export default meta
type Story = StoryObj<typeof meta>

// Web/no-backend branch — counters show placeholders (no live polling).
export const Default: Story = {}

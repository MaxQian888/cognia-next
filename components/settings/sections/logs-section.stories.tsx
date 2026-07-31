import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { LogsSection } from "./logs-section"

// Renders the "Open Log Panel" link card above the embedded multi-tab
// `LogSettings` configuration UI (level / transports / retention / sampling).
// No Tauri or store seeding required — it reads its own logging config. The
// `onClose` callback (fired by the panel link) is a spy.
const meta = {
  title: "Settings/Sections/LogsSection",
  component: LogsSection,
  parameters: { layout: "padded" },
  args: { onClose: fn() },
  decorators: [
    (Story) => (
      <div className="w-[720px] max-w-full">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof LogsSection>

export default meta
type Story = StoryObj<typeof meta>

// Link card + full LogSettings surface.
export const Default: Story = {}

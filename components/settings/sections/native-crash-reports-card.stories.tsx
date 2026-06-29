import type { Meta, StoryObj } from "@storybook/nextjs"

import { NativeCrashReportsCard } from "./native-crash-reports-card"

// Tauri-branching: the Rust crash-report subsystem only exists under the
// desktop shell. In the Storybook browser (`isTauri()` is false) the card
// renders its "desktop only" note with the refresh / open-folder actions
// disabled — the reachable web branch.
const meta = {
  title: "Settings/Sections/NativeCrashReportsCard",
  component: NativeCrashReportsCard,
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <div className="w-[560px] max-w-full">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof NativeCrashReportsCard>

export default meta
type Story = StoryObj<typeof meta>

// Web branch — "desktop only" note, actions disabled.
export const Default: Story = {}

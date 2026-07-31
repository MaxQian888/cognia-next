import type { Meta, StoryObj } from "@storybook/nextjs"

import { StatusBarPerf } from "./status-bar-perf"

// Compact performance segment. It reads the native perf sampler, which is only
// available under Tauri — in Storybook (web) `usePerfStream().available` is
// false, so the component renders nothing. Shown here for API/reference only.
const meta = {
  title: "Desktop/StatusBar/Perf",
  component: StatusBarPerf,
  parameters: { layout: "centered" },
  decorators: [
    (Story) => (
      <div className="flex h-6 items-center border-t bg-muted/40 text-[11px]">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof StatusBarPerf>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

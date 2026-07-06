import type { Meta, StoryObj } from "@storybook/nextjs"

import { CrashLogSettings } from "./crash-log-settings"

// `CrashLogSettings` is the two-pane crash/diagnostics viewer driven by the
// `useCrashLogs` hook. The hook aggregates recent in-memory error logs, the
// IndexedDB log transport, and native logging diagnostics. In the browser
// preview there is no native logging and the error buffer is empty, so it
// renders its toolbar (stats strip + actions) over the list/detail empty
// states — the realistic "nothing has gone wrong yet" surface.
const meta = {
  title: "Settings/System/CrashLogSettings",
  component: CrashLogSettings,
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <div className="h-[640px] p-4">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof CrashLogSettings>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

import type { Meta, StoryObj } from "@storybook/nextjs"

import { JobCenterPanel } from "./job-center-panel"

// Status-bar "job center" trigger + sheet listing background tasks (renderer
// host) read reactively from Dexie. With an empty DB the sheet shows its empty
// state. Click the briefcase trigger to open the sheet.
const meta = {
  title: "Desktop/JobCenterPanel",
  component: JobCenterPanel,
  parameters: { layout: "centered" },
  decorators: [
    (Story) => (
      <div className="flex h-6 items-center border bg-muted/40 text-[11px]">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof JobCenterPanel>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

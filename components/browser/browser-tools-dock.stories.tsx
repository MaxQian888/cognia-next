import type { Meta, StoryObj } from "@storybook/nextjs"

import { BrowserToolsDock } from "./browser-tools-dock"

// The pane's single bottom strip. Its header is laid out by a container query,
// so the same props render differently in the chat rail (~300px) and on
// `/browser`: below the breakpoint the badges give way to dots on the tabs and
// the tab list scrolls sideways instead of pushing the toggle out of the pane.
const meta = {
  title: "Browser/BrowserToolsDock",
  component: BrowserToolsDock,
  parameters: { layout: "padded" },
  args: {
    recorder: <p className="text-xs text-muted-foreground">Recorder body</p>,
    console: <p className="text-xs text-muted-foreground">Console body</p>,
    network: <p className="text-xs text-muted-foreground">Network body</p>,
    developer: <p className="text-xs text-muted-foreground">Developer body</p>,
    consoleCount: 12,
    networkCount: 48,
    problemCount: 2,
    failedRequests: 1,
    recordingSteps: 5,
  },
} satisfies Meta<typeof BrowserToolsDock>

export default meta
type Story = StoryObj<typeof meta>

export const ChatRail: Story = {
  decorators: [
    (Story) => (
      <div className="w-[300px] rounded-md border">
        <Story />
      </div>
    ),
  ],
}

export const FullPage: Story = {
  decorators: [
    (Story) => (
      <div className="w-[760px] rounded-md border">
        <Story />
      </div>
    ),
  ],
}

export const Quiet: Story = {
  args: { problemCount: 0, failedRequests: 0, recordingSteps: null },
  decorators: [
    (Story) => (
      <div className="w-[300px] rounded-md border">
        <Story />
      </div>
    ),
  ],
}

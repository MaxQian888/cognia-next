import type { Meta, StoryObj } from "@storybook/nextjs"

import { PerfOverviewTab } from "./perf-overview-tab"
import { makeFrames, makeSource } from "@/lib/storybook/fixtures/performance"

// Task-Manager "Performance" layout: a per-source rail of metric tiles (the
// selected host, then this window) and a large rolling graph for the selected
// metric. Tiles appear only for metrics their source advertises.
const meta = {
  title: "Performance/PerfOverviewTab",
  component: PerfOverviewTab,
  args: {
    rendererHistory: makeFrames("renderer", 40),
    hostHistory: makeFrames("host", 40),
    sources: [makeSource("renderer"), makeSource("host")],
    hostState: "live",
    selectedMetric: null,
    onSelectMetric: () => {},
    intervalMs: 1000,
    onOpenDiagnose: () => {},
  },
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <div className="h-[640px] w-full p-4">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof PerfOverviewTab>

export default meta
type Story = StoryObj<typeof meta>

export const DesktopWithHost: Story = {}

/** Web and mobile: no host, only what the browser can measure. */
export const BrowserOnly: Story = {
  args: { hostHistory: [], sources: [makeSource("renderer")], hostState: "unsupported" },
}

/** WebKit exposes no long tasks or heap: fewer tiles, never zero lines. */
export const WebKitRenderer: Story = {
  args: {
    hostHistory: [],
    sources: [makeSource("renderer", ["renderer.fps", "renderer.user-timing"])],
    hostState: "unsupported",
  },
}

export const HostConnecting: Story = {
  args: { hostHistory: [], hostState: "connecting", sources: [makeSource("renderer")] },
}

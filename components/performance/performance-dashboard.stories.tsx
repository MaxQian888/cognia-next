import type { Meta, StoryObj } from "@storybook/nextjs"

import { PerformanceDashboard } from "./performance-dashboard"

// The Task-Manager-style master panel, driven by the live `usePerfStream`
// sampler. In Storybook (web) the Tauri backend is absent, so `available` is
// false and the panel renders its inert "desktop-only" explainer rather than an
// empty shell — which is exactly the web/mobile fallback this story documents.
const meta = {
  title: "Performance/PerformanceDashboard",
  component: PerformanceDashboard,
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <div className="h-[600px] w-full">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof PerformanceDashboard>

export default meta
type Story = StoryObj<typeof meta>

export const DesktopOnlyFallback: Story = {}

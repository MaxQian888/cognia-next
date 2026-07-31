import type { Meta, StoryObj } from "@storybook/nextjs"

import { GatewaySection } from "./gateway-section"

// `GatewaySection` is desktop-only (the inbound LLM gateway lives in the Tauri
// runtime). In the browser preview `isTauri()` is false, so the component takes
// its web branch and renders the "desktop only" notice — the listener controls,
// key manager, request log, and route tickets are reachable only in the desktop
// build. What these stories *do* exercise is the master/detail shell: the nav
// rail, panel routing, and the container-query behaviour of the detail pane.
const meta = {
  title: "Settings/Gateway/GatewaySection",
  component: GatewaySection,
  parameters: { layout: "fullscreen", nextjs: { appDirectory: true } },
} satisfies Meta<typeof GatewaySection>

export default meta
type Story = StoryObj<typeof meta>

/**
 * `GatewaySection` returns the desktop-only notice *before* it builds the
 * master/detail shell, so the browser preview cannot reach the nav rail or any
 * panel — a per-panel story here would just render this notice N times. The
 * panels are previewable only in the desktop build; their behaviour is pinned
 * by the co-located tests instead.
 */
export const Default: Story = {
  decorators: [
    (Story) => (
      <div className="h-[720px] w-[960px] p-4">
        <Story />
      </div>
    ),
  ],
}

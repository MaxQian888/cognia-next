import type { Meta, StoryObj } from "@storybook/nextjs"

import { DesktopSection } from "./desktop-section"

// `DesktopSection` aggregates desktop-only preferences (autostart, OS info,
// tray, shortcuts) that depend on the Tauri runtime. In the browser preview
// `isTauri()` is false, so it renders its web-mode hint message instead of the
// native controls — the full surface is only reachable in `pnpm tauri dev`.
const meta = {
  title: "Settings/DesktopSection",
  component: DesktopSection,
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <div className="max-w-2xl">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof DesktopSection>

export default meta
type Story = StoryObj<typeof meta>

// Web/preview branch: the "available in the desktop build" hint.
export const Default: Story = {}

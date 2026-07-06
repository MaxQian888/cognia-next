import type { Meta, StoryObj } from "@storybook/nextjs"

import { MobileTerminalScreen } from "./mobile-terminal-screen"
import { resetStore } from "@/lib/storybook/seed-stores"
import { useTerminalStore } from "@/stores/terminal/terminal-store"
import { useProjectStore } from "@/stores/project/project-store"

// Full-screen mobile terminal. With no live sessions in the terminal store it
// renders the header (back / search / history / new) over the empty state. The
// transport resolves to "unsupported" in the plain-web Storybook browser, so the
// empty state shows the "unavailable" copy (no spawn button). Mounting an
// attached session would boot xterm against a live PTY, which isn't available
// here — the empty state is the storyable surface.
const meta = {
  title: "Mobile/MobileTerminalScreen",
  component: MobileTerminalScreen,
  parameters: { layout: "fullscreen" },
  beforeEach: () => {
    resetStore(useTerminalStore)
    resetStore(useProjectStore)
  },
  decorators: [
    (Story) => (
      <div className="mx-auto h-[760px] w-[390px] overflow-hidden border">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof MobileTerminalScreen>

export default meta
type Story = StoryObj<typeof meta>

export const EmptyState: Story = {}

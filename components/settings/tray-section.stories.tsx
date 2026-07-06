import type { Meta, StoryObj } from "@storybook/nextjs"

import { TraySection } from "./tray-section"
import { resetStore } from "@/lib/storybook/seed-stores"
import { useTrayStore } from "@/lib/tray/store"

// `TraySection` edits the desktop tray menu (reorder / rename / show-hide). The
// tray exists only in the Tauri runtime, so in the browser preview `isTauri()`
// is false and the component renders its "desktop only" message. The store is
// still reset so story order can't leak edited items.
const meta = {
  title: "Settings/TraySection",
  component: TraySection,
  parameters: { layout: "padded" },
  beforeEach: () => {
    resetStore(useTrayStore)
  },
  decorators: [
    (Story) => (
      <div className="max-w-2xl">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof TraySection>

export default meta
type Story = StoryObj<typeof meta>

// Web/preview branch: the desktop-only message.
export const Default: Story = {}

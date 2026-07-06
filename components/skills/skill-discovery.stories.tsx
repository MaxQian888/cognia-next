import type { Meta, StoryObj } from "@storybook/nextjs"

import { SkillDiscovery } from "./skill-discovery"
import { resetStore } from "@/lib/storybook/seed-stores"
import { useSkillsStore } from "@/stores/skills"

// Tauri-branching: native scans go through `isTauri()`/IPC which is unavailable
// in the Storybook (web) runtime. The scan controls render; triggering a scan
// surfaces the desktop-only path.
const meta = {
  title: "Skills/SkillDiscovery",
  component: SkillDiscovery,
  parameters: { layout: "fullscreen" },
  beforeEach: () => {
    resetStore(useSkillsStore)
  },
  decorators: [
    (Story) => (
      <div className="mx-auto max-w-xl p-4">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof SkillDiscovery>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

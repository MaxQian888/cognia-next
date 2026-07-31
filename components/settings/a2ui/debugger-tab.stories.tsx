import type { Meta, StoryObj } from "@storybook/nextjs"

import { DebuggerTab } from "./debugger-tab"
import { resetStore } from "@/lib/storybook/seed-stores"
import { seedDb } from "@/lib/storybook/seed-db"
import { useA2UIStore } from "@/stores/a2ui"

// `DebuggerTab` streams A2UI events: live from `globalEventEmitter` plus
// persisted history from the Dexie `a2uiEventHistory` table, with surface /
// type filters and a JSON detail inspector. On an empty database it shows the
// "no events" state alongside the inspector hint.
const meta = {
  title: "Settings/A2UI/DebuggerTab",
  component: DebuggerTab,
  parameters: { layout: "padded" },
  beforeEach: async () => {
    resetStore(useA2UIStore)
    await seedDb(() => {})
  },
  decorators: [
    (Story) => (
      <div className="max-w-4xl">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof DebuggerTab>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

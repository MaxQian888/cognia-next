import type { Meta, StoryObj } from "@storybook/nextjs"

import { ShortcutsSection } from "./shortcuts-section"
import { resetStores } from "@/lib/storybook/seed-stores"
import { useShortcutStore } from "@/lib/shortcuts/registry"
import { useTrayStore } from "@/lib/tray/store"

// `ShortcutsSection` renders the rebindable global shortcuts. It reads bindings
// from `useShortcutStore` (which hydrates from the Rust registry; in Storybook
// it falls back to the built-in defaults) and tray items from `useTrayStore`.
// Both stores are reset so a captured chord from one story can't leak into
// another.
const meta = {
  title: "Settings/ShortcutsSection",
  component: ShortcutsSection,
  parameters: { layout: "padded" },
  beforeEach: () => {
    resetStores(useShortcutStore, useTrayStore)
  },
  decorators: [
    (Story) => (
      <div className="max-w-2xl">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ShortcutsSection>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

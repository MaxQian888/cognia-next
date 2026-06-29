import type { Meta, StoryObj } from "@storybook/nextjs"

import { CharactersSection } from "./characters-section"
import { seedDb } from "@/lib/storybook/seed-db"
import { resetStores } from "@/lib/storybook/seed-stores"
import { usePluginStore } from "@/stores/plugin-runtime/plugin-store"
import { useUIStore } from "@/stores/ui/ui-store"

// `CharactersSection` is the character roster + editor. It reads characters /
// skills / packs from Dexie via `useLiveQuery` and touches the plugin and UI
// stores. `seedDb` waits for the built-in seed (starter characters), and both
// stores are reset so editor/drawer state can't leak between stories.
const meta = {
  title: "Settings/CharactersSection",
  component: CharactersSection,
  parameters: { layout: "fullscreen" },
  beforeEach: async () => {
    resetStores(usePluginStore, useUIStore)
    await seedDb(() => {})
  },
  decorators: [
    (Story) => (
      <div className="h-[680px] overflow-auto p-4">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof CharactersSection>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

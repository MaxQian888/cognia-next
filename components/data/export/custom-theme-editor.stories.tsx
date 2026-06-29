import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { CustomThemeEditor } from "./custom-theme-editor"
import { resetStore } from "@/lib/storybook/seed-stores"
import { useCustomThemeStore } from "@/stores/theme"

// Per-token palette editor for HTML export themes. Saved themes live in
// `useCustomThemeStore` (localStorage-backed); seeded fresh per story.
const meta = {
  title: "Data/CustomThemeEditor",
  component: CustomThemeEditor,
  args: { selectedId: null, builtInBase: "light", onSelect: fn() },
  parameters: { layout: "padded" },
  beforeEach: () => {
    resetStore(useCustomThemeStore)
  },
  decorators: [
    (Story) => (
      <div className="w-[28rem]">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof CustomThemeEditor>

export default meta
type Story = StoryObj<typeof meta>

export const NewDraftFromLight: Story = {}

export const NewDraftFromDark: Story = { args: { builtInBase: "dark" } }

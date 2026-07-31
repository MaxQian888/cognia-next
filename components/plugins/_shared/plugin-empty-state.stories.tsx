import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { fn } from "storybook/test"
import { SearchIcon } from "lucide-react"

import { PluginEmptyState } from "./plugin-empty-state"

// Shared empty-state shell for plugin surfaces (Marketplace browse, Discover
// sheet, Library list, DevTools dropzone). Stories cover the i18n defaults,
// a custom title/hint pair, a CTA action button, and a custom icon.

const meta = {
  title: "Plugins/Shared/PluginEmptyState",
  component: PluginEmptyState,
  args: {},
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <div className="w-[420px] max-w-full">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof PluginEmptyState>

export default meta
type Story = StoryObj<typeof meta>

// Default title + hint from the shared i18n namespace.
export const Default: Story = {}

// Call-site overrides for a search-returned-nothing surface.
export const CustomCopy: Story = {
  args: {
    title: "No plugins match your search",
    hint: "Try a different keyword or clear the filters.",
    icon: <SearchIcon className="size-5" />,
  },
}

// Empty state with a CTA button under the description.
export const WithAction: Story = {
  args: {
    title: "Your library is empty",
    hint: "Browse the marketplace to install your first plugin.",
    action: { label: "Browse marketplace", onClick: fn() },
  },
}

import type { Meta, StoryObj } from "@storybook/nextjs"

import { LspDevToggle, type LspDevToggleProps } from "./lsp-dev-toggle"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { useSettingsStore } from "@/stores/settings"
import type { AppSettings } from "@/lib/claude/types"

// `LspDevToggle` controls `developer.unsignedLspAllowed`. It hides itself in
// production builds; the `isDevBuild` prop is the test seam that forces the
// branch, so stories pin it explicitly rather than depending on NODE_ENV.
function seedSettings(patch: Partial<AppSettings>) {
  return () => {
    resetStore(useSettingsStore)
    seedStore(useSettingsStore, { settings: patch as unknown as AppSettings })
  }
}

const meta = {
  title: "Settings/Developer/LspDevToggle",
  component: LspDevToggle,
  parameters: { layout: "padded" },
  args: { isDevBuild: true },
  beforeEach: () => {
    resetStore(useSettingsStore)
  },
  decorators: [
    (Story) => (
      <div className="max-w-xl">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<LspDevToggleProps>

export default meta
type Story = StoryObj<LspDevToggleProps>

// Dev build, toggle off (default).
export const Default: Story = {}

// Dev build with unsigned LSP binaries already allowed.
export const Allowed: Story = {
  beforeEach: seedSettings({
    developer: { unsignedLspAllowed: true },
  } as unknown as Partial<AppSettings>),
}

// Production build — the component renders nothing (returns `null`).
export const ProductionHidden: Story = {
  args: { isDevBuild: false },
}

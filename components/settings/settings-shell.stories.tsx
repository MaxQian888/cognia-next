import type { Meta, StoryObj } from "@storybook/nextjs"

import type { ReactNode } from "react"

import { SettingsShell } from "./settings-shell"
import { resetStore } from "@/lib/storybook/seed-stores"
import { useSettingsStore } from "@/stores/settings"

// `SettingsShell`'s sole prop is optional with a default arg, which makes
// Storybook infer story args as `never`; type the story against the prop shape.
type SettingsShellProps = { actions?: ReactNode }

// `SettingsShell` is the full settings layout: it mounts its own
// `<SidebarProvider>`, the `SettingsSidebar` rail, a header breadcrumb, and the
// active section pane (default `?section=providers`). The section content reads
// the settings store + Dexie; in the empty Storybook environment it renders the
// providers pane in its empty/loading state. Sized as a fullscreen frame.
const meta = {
  title: "Settings/SettingsShell",
  component: SettingsShell,
  parameters: { layout: "fullscreen" },
  beforeEach: () => {
    resetStore(useSettingsStore)
  },
  decorators: [
    (Story) => (
      <div className="h-screen w-full">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<SettingsShellProps>

export default meta
type Story = StoryObj<SettingsShellProps>

export const Default: Story = {}

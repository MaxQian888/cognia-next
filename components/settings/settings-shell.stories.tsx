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

/**
 * The three sections that moved from card stacks to master/detail. They only
 * look like Providers when the shell puts them in its fill-height branch, and
 * that branch is chosen by section id — so it is only visible from the shell,
 * never from the section's own story. `?section=` is read through
 * `useSearchParams`, which @storybook/nextjs mocks from this query object.
 */
const atSection = (section: string): Story => ({
  parameters: { nextjs: { appDirectory: true, navigation: { query: { section } } } },
})

export const AgentRuntime = atSection("agent-runtime")
export const AgentModes = atSection("agent-modes")
export const Memory = atSection("memory")

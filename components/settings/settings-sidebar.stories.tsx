import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { SettingsSidebar } from "./settings-sidebar"
import { SidebarProvider } from "@/components/ui/sidebar"

// `SettingsSidebar` is the grouped, searchable settings nav rail. It calls
// `useSidebar()`, so it must render inside a `<SidebarProvider>`. Props drive the
// active section and the search box; the callbacks are spied with `fn()`.
const meta = {
  title: "Settings/SettingsSidebar",
  component: SettingsSidebar,
  parameters: { layout: "fullscreen" },
  args: {
    activeSection: "providers",
    searchQuery: "",
    onSelect: fn(),
    onSearchChange: fn(),
  },
  decorators: [
    (Story) => (
      <SidebarProvider>
        <div className="h-[640px]">
          <Story />
        </div>
      </SidebarProvider>
    ),
  ],
} satisfies Meta<typeof SettingsSidebar>

export default meta
type Story = StoryObj<typeof meta>

// Full grouped nav with the "providers" item active.
export const Default: Story = {}

// A search query filters items; every group with a hit is force-expanded.
export const Searching: Story = {
  args: { searchQuery: "theme" },
}

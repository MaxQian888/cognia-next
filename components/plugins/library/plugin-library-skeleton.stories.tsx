import type { Meta, StoryObj } from "@storybook/nextjs-vite"

import { PluginLibraryListSkeleton, PluginLibraryGridSkeleton } from "./plugin-library-skeleton"

// Loading-state placeholders for the Plugins → Library pane. List = stacked
// rows, grid = card placeholders mirroring PluginCard. Purely presentational
// (count-driven), so the stories just render each at a representative count.
// The grid skeleton reads the `@container/plugin-grid` query it mounts itself,
// so its responsive columns light up as the preview canvas widens.

const meta = {
  title: "Plugins/Library/PluginLibrarySkeleton",
  component: PluginLibraryListSkeleton,
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <div className="w-[760px] max-w-full">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof PluginLibraryListSkeleton>

export default meta
type Story = StoryObj<typeof meta>

export const List: Story = {
  args: { count: 6 },
}

export const Grid: StoryObj = {
  render: () => <PluginLibraryGridSkeleton count={6} />,
}

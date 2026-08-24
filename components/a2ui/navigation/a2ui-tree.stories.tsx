import type { Meta, StoryObj } from "@storybook/nextjs"
import * as React from "react"

import { A2UITree } from "./a2ui-tree"
import type { A2UITreeComponent } from "@/types/artifact/a2ui"
import { makeA2UIProps } from "@/lib/storybook/fixtures/a2ui"

const tree = (over: Partial<A2UITreeComponent> = {}): A2UITreeComponent => ({
  id: "tree",
  component: "Tree",
  action: "open-page",
  expandAction: "load-children",
  nodes: [
    {
      id: "overview",
      label: "Overview",
      icon: "book-open",
    },
    {
      id: "lib",
      label: "lib",
      icon: "folder",
      badge: "42",
      children: [
        {
          id: "lib/plugin",
          label: "plugin",
          icon: "folder",
          children: [
            { id: "lib/plugin/core", label: "core", icon: "file-text" },
            { id: "lib/plugin/bridge", label: "bridge", icon: "file-text" },
          ],
        },
        { id: "lib/a2ui", label: "a2ui", icon: "file-text" },
      ],
    },
    {
      id: "crates",
      label: "crates",
      icon: "folder",
      children: [{ id: "crates/runtime", label: "cognia-plugin-runtime", icon: "file-text" }],
    },
    { id: "archived", label: "archived", icon: "archive", disabled: true },
  ],
  ...over,
})

const meta = {
  title: "A2UI/Navigation/Tree",
  component: A2UITree,
  decorators: [
    (Story: React.ComponentType) => <div className="w-72 rounded-lg border p-2">{<Story />}</div>,
  ],
} satisfies Meta<typeof A2UITree>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = { args: makeA2UIProps(tree()) }

export const FullyExpanded: Story = {
  args: makeA2UIProps(tree({ defaultExpandedDepth: 3, selectedId: "lib/plugin/core" })),
}

export const Collapsed: Story = { args: makeA2UIProps(tree({ defaultExpandedDepth: 0 })) }

export const Empty: Story = { args: makeA2UIProps(tree({ nodes: [] })) }

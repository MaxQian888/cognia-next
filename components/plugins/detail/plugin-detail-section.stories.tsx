import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { fn } from "storybook/test"
import {
  BlocksIcon,
  DatabaseIcon,
  ScrollTextIcon,
  Settings2Icon,
  ShieldCheckIcon,
} from "lucide-react"

import { PluginDetailSection } from "./plugin-detail-section"

// Collapsible section wrapper used by the README-centric plugin detail pane.
// Each section (Capabilities / Configure / Permissions / Data / Logs) is a
// controlled Collapsible — exactly one is open at a time, driven by the
// store's `detailSubTab`. This is a pure prop-driven presentation component
// (icon + title + open + children), so the stories just exercise the
// open/closed states and a stacked "Page" of sections the way the detail pane
// renders them.

const meta = {
  title: "Plugins/Detail/PluginDetailSection",
  component: PluginDetailSection,
  args: {
    icon: BlocksIcon,
    title: "Capabilities",
    open: true,
    onOpenChange: fn(),
    children: (
      <div className="space-y-2 text-sm text-muted-foreground">
        <p>This plugin contributes 4 tools, 2 commands, and 1 theme.</p>
        <p>Toggle a capability to hide it from the agent without uninstalling.</p>
      </div>
    ),
  },
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <div className="w-[640px] max-w-full">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof PluginDetailSection>

export default meta
type Story = StoryObj<typeof meta>

export const Open: Story = {}

export const Closed: Story = {
  args: { open: false, title: "Permissions", icon: ShieldCheckIcon },
}

export const WithTestId: Story = {
  args: { testId: "section-data", title: "Data", icon: DatabaseIcon },
}

// The detail pane stacks every section vertically, only one expanded at a
// time. This composite mirrors that layout: Configure is open, the rest are
// collapsed.
export const Page: Story = {
  render: () => {
    const sections = [
      { key: "capabilities", icon: BlocksIcon, title: "Capabilities", open: false },
      { key: "configure", icon: Settings2Icon, title: "Configure", open: true },
      { key: "permissions", icon: ShieldCheckIcon, title: "Permissions", open: false },
      { key: "data", icon: DatabaseIcon, title: "Data", open: false },
      { key: "logs", icon: ScrollTextIcon, title: "Logs", open: false },
    ] as const
    return (
      <div className="space-y-2">
        {sections.map((section) => (
          <PluginDetailSection
            key={section.key}
            icon={section.icon}
            title={section.title}
            open={section.open}
            onOpenChange={fn()}
            testId={`section-${section.key}`}
          >
            <p className="text-sm text-muted-foreground">{section.title} content goes here.</p>
          </PluginDetailSection>
        ))}
      </div>
    )
  },
}

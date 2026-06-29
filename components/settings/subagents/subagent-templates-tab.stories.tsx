import type { Meta, StoryObj } from "@storybook/nextjs"

import { SubagentTemplatesTab } from "./subagent-templates-tab"
import { resetStore } from "@/lib/storybook/seed-stores"
import { useSubagentRuntimeStore } from "@/stores/agent/subagent-runtime-store"

// `SubagentTemplatesTab` is a CRUD surface over the runtime store's subagent
// templates: built-ins are read-only (duplicate-to-fork), user copies are
// editable/deletable. It also exposes the import wizard and a search +
// category filter bar. Resetting restores the seeded built-in templates.
const meta = {
  title: "Settings/Subagents/SubagentTemplatesTab",
  component: SubagentTemplatesTab,
  parameters: { layout: "padded" },
  beforeEach: () => {
    resetStore(useSubagentRuntimeStore)
  },
  decorators: [
    (Story) => (
      <div className="max-w-4xl">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof SubagentTemplatesTab>

export default meta
type Story = StoryObj<typeof meta>

// Built-in templates with the search + category filter toolbar.
export const Default: Story = {}

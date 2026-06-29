import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { TwinSelector } from "./twin-selector"
import { makeTwin } from "@/lib/storybook/fixtures/twin"

// Pure props-only — twins array + active id. Create/rename/clone/delete go
// through Dexie on submit; the spies record selection / after-create / delete.
const twins = [
  makeTwin({ name: "Support Engineer", color: "#6366f1" }),
  makeTwin({ name: "Sales Lead", color: "#10b981" }),
  makeTwin({ name: "Archived Persona", archived: true }),
]

const meta = {
  title: "Twin/TwinSelector",
  component: TwinSelector,
  parameters: { layout: "padded" },
  args: {
    twins,
    activeTwinId: twins[0].id,
    onSelect: fn(),
    onAfterDelete: fn(),
    onAfterCreate: fn(),
  },
  decorators: [
    (Story) => (
      <div className="max-w-xs">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof TwinSelector>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

export const WithArchived: Story = {
  args: { includeArchived: true },
}

export const Empty: Story = {
  args: { twins: [], activeTwinId: null },
}

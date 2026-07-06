import type { Meta, StoryObj } from "@storybook/nextjs"

import { EntitiesSubtab } from "./entities-subtab"
import { makeEntity } from "@/lib/storybook/fixtures/twin"

// Pure rendering — the parent passes the entities array (sourced upstream from
// a `useLiveQuery`). Writes go through Dexie only on row actions.
const meta = {
  title: "Twin/Persona/EntitiesSubtab",
  component: EntitiesSubtab,
  parameters: { layout: "padded" },
  args: {
    twinId: "twin-1",
    entities: [
      makeEntity({ name: "Acme Corp", role: "project", pinned: true }),
      makeEntity({ name: "Dana Lee", role: "person", relation: "Manager" }),
      makeEntity({ name: "Billing Service", role: "system" }),
    ],
  },
  decorators: [
    (Story) => (
      <div className="max-w-2xl">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof EntitiesSubtab>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

export const Empty: Story = {
  args: { entities: [] },
}

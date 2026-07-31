import type { Meta, StoryObj } from "@storybook/nextjs"

import { SessionsTab } from "./sessions-tab"

// `SessionsTab` is a Dexie-backed table of chat sessions enriched with
// per-session token + cost totals (Resume / Fork / Rename / Delete). On the web
// preview it opens an empty IndexedDB, so it renders its "no sessions" empty
// state. (Seeding `ChatSession` + `sessionUsage` rows is possible via
// `seedDb`, but the empty state is the meaningful default here.)
const meta = {
  title: "Settings/AgentRuntime/Tabs/SessionsTab",
  component: SessionsTab,
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <div className="max-w-4xl">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof SessionsTab>

export default meta
type Story = StoryObj<typeof meta>

// Empty database — the "no sessions" state with the filter input.
export const Default: Story = {}

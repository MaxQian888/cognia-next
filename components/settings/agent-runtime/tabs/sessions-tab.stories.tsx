import type { Meta, StoryObj } from "@storybook/nextjs"

import { SessionsTab } from "./sessions-tab"

// `SessionsTab` is the runtime view of conversations: the entry card into the
// Conversations page (live active/archived counts), the conversations bound to
// a native Claude Agent SDK session (open / fork SDK session / unlink), and the
// native SDK session manager. On the web preview it opens an empty IndexedDB
// and has no agent host, so it renders zero counts, the "nothing bound yet"
// empty state, and no native SDK block.
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

// Empty database — zero counts and the "nothing bound yet" empty state.
export const Default: Story = {}

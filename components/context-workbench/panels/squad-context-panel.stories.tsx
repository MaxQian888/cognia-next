import type { Meta, StoryObj } from "@storybook/nextjs-vite"

import { SquadContextPanel } from "./squad-context-panel"

const meta = {
  title: "ContextWorkbench/SquadContextPanel",
  component: SquadContextPanel,
  args: { sessionId: "s1" },
  parameters: {
    docs: {
      description: {
        component:
          "The Squad running the current conversation. The binding is read from Dexie and the roster from the agent-team store, so only the unbound state renders standalone here — the populated states are covered by the co-located tests, which can seed both.",
      },
    },
  },
  decorators: [
    (Story) => (
      <div className="h-96 w-80 overflow-hidden rounded-md border">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof SquadContextPanel>

export default meta
type Story = StoryObj<typeof meta>

/**
 * The default for any conversation that has not been handed to a Squad. Names
 * the composer rather than offering a second control for the same decision.
 */
export const RunsOnASingleAgent: Story = {}

/** No conversation yet — the panel does not claim a rail slot it cannot fill. */
export const NoConversation: Story = { args: { sessionId: null } }

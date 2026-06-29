import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { TerminalHistoryPanel } from "./terminal-history-panel"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { useTerminalStore } from "@/stores/terminal/terminal-store"
import { makeTerminalSession, makeCommandRecord } from "@/lib/storybook/fixtures/terminal"

// Collapsible per-tab command-history rail. Reads `lastCommands` + `historyOpen`
// from the terminal store, so each story reseeds the session row it reads.
const SESSION_ID = "term_history_story"

function seed(over: Parameters<typeof makeTerminalSession>[0] = {}) {
  resetStore(useTerminalStore)
  seedStore(useTerminalStore, {
    sessions: {
      [SESSION_ID]: makeTerminalSession({ id: SESSION_ID, ...over }),
    },
  })
}

const meta = {
  title: "Terminal/HistoryPanel",
  component: TerminalHistoryPanel,
  parameters: { layout: "fullscreen" },
  args: { sessionId: SESSION_ID },
  decorators: [
    (Story) => (
      <div className="relative h-72 w-full bg-[#1f2430]">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof TerminalHistoryPanel>

export default meta
type Story = StoryObj<typeof meta>

// Closed → just the small open-rail toggle button.
export const Collapsed: Story = {
  beforeEach: () => seed({ historyOpen: false }),
}

export const OpenWithHistory: Story = {
  beforeEach: () =>
    seed({
      historyOpen: true,
      lastCommands: [
        makeCommandRecord({ cmd: "pnpm install", exitCode: 0, endedAt: Date.now() - 600_000 }),
        makeCommandRecord({ cmd: "pnpm test", exitCode: 1, endedAt: Date.now() - 120_000 }),
        makeCommandRecord({ cmd: "git status", exitCode: 0, endedAt: Date.now() - 30_000 }),
      ],
    }),
}

export const OpenEmpty: Story = {
  beforeEach: () => seed({ historyOpen: true, lastCommands: [] }),
}

export const AgentSpawned: Story = {
  beforeEach: () =>
    seed({
      historyOpen: true,
      agentSpawner: "chat_7",
      lastCommands: [makeCommandRecord({ cmd: "cargo build", exitCode: 0 })],
    }),
  args: { onLocateInChat: fn() },
}

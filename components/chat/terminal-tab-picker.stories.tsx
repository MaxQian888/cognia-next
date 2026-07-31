import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { TerminalTabPicker } from "./terminal-tab-picker"
import { Button } from "@/components/ui/button"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { useTerminalStore, type TerminalSessionRow } from "@/stores/terminal/terminal-store"
import { useProjectStore } from "@/stores/project/project-store"

// Tab picker (cmdk) for "Run in dock" on a Bash tool call. Lists the active
// project's terminal tabs plus a "New tab" option. Open by default so the
// popover content shows; tabs come from the terminal store.
const PROJECT = "proj-1"

const tab = (over: Partial<TerminalSessionRow>): TerminalSessionRow =>
  ({
    id: "t1",
    projectId: PROJECT,
    extensionId: null,
    title: "bash",
    customTitle: null,
    shell: "bash",
    origin: "local",
    status: "running",
    exitCode: null,
    cwd: "/repo",
    createdAt: 1_700_000_000_000,
    agentTrusted: false,
    agentSpawner: null,
    promptBoundaries: [],
    lastCommands: [],
    historyOpen: false,
    ...over,
  }) as TerminalSessionRow

const seed = (tabs: TerminalSessionRow[]) => () => {
  resetStore(useTerminalStore)
  seedStore(useProjectStore, { activeProjectId: PROJECT })
  seedStore(useTerminalStore, {
    sessions: Object.fromEntries(tabs.map((t) => [t.id, t])),
  })
}

const meta = {
  title: "Chat/TerminalTabPicker",
  component: TerminalTabPicker,
  parameters: { layout: "centered" },
  args: {
    open: true,
    onOpenChange: fn(),
    onPick: fn(),
    children: <Button variant="outline">Run in dock</Button>,
  },
  beforeEach: seed([
    tab({ id: "t1", customTitle: "build" }),
    tab({ id: "t2", customTitle: "dev server", agentTrusted: true, createdAt: 1_700_000_100_000 }),
  ]),
} satisfies Meta<typeof TerminalTabPicker>

export default meta
type Story = StoryObj<typeof meta>

/** Two existing tabs (one agent-trusted) plus the New tab option. */
export const WithTabs: Story = {}

/** No existing tabs — only the New tab option + empty state. */
export const NoTabs: Story = {
  beforeEach: seed([]),
}

import type { Meta, StoryObj } from "@storybook/nextjs"

import { TerminalProjectOverride } from "./terminal-project-override"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { useProjectStore } from "@/stores/project/project-store"

// `TerminalProjectOverride` lets the user pick a project and override its
// `terminalConfig.shell` / `cwd`. It reads the project list from
// `useProjectStore`; with no projects it shows the "no projects" notice.
const sampleProjects = [
  { id: "proj-web", name: "cognia-next", rootDir: "/home/dev/cognia-next", terminalConfig: {} },
  {
    id: "proj-api",
    name: "api-server",
    rootDir: "/home/dev/api",
    terminalConfig: { shell: "/bin/zsh", cwd: "/home/dev/api/src" },
  },
]

const meta = {
  title: "Settings/Terminal/TerminalProjectOverride",
  component: TerminalProjectOverride,
  parameters: { layout: "padded" },
  beforeEach: () => {
    resetStore(useProjectStore)
  },
  decorators: [
    (Story) => (
      <div className="max-w-md">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof TerminalProjectOverride>

export default meta
type Story = StoryObj<typeof meta>

// No projects — the "no projects" notice.
export const Empty: Story = {}

// A couple of projects available to pick + override.
export const WithProjects: Story = {
  beforeEach: () => {
    resetStore(useProjectStore)
    seedStore(useProjectStore, { projects: sampleProjects } as never)
  },
}

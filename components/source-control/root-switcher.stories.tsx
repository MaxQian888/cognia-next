import type { Meta, StoryObj } from "@storybook/nextjs"

import { RootSwitcher } from "./root-switcher"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { useGitStore } from "@/stores/git/git-store"
import { useProjectStore } from "@/stores/project/project-store"
import type { Project } from "@/types"

// RootSwitcher renders only for multi-root workspaces: it reads the active
// project's roots (project store) and the bound `rootDir` (git store). Single
// or rootless workspaces render nothing, so every story seeds >= 2 roots.
const project = {
  id: "p1",
  name: "Cognia",
  roots: [
    { id: "root-a", path: "/work/cognia-app", label: "app", isPrimary: true },
    { id: "root-b", path: "/work/cognia-docs", label: "docs" },
    { id: "root-c", path: "/work/cognia-services", label: "services" },
  ],
  knowledgeBase: [],
} as unknown as Project

function seed(rootDir: string) {
  resetStore(useProjectStore)
  resetStore(useGitStore)
  seedStore(useProjectStore, { projects: [project], activeProjectId: project.id })
  seedStore(useGitStore, { rootDir })
}

const meta = {
  title: "SourceControl/RootSwitcher",
  component: RootSwitcher,
  parameters: { layout: "padded" },
  beforeEach: () => seed("/work/cognia-app"),
} satisfies Meta<typeof RootSwitcher>

export default meta
type Story = StoryObj<typeof meta>

export const PrimaryRoot: Story = {}

export const SecondaryRoot: Story = {
  beforeEach: () => seed("/work/cognia-docs"),
}

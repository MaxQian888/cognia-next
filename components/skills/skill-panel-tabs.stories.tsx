import type { Meta, StoryObj } from "@storybook/nextjs"

import { SkillPanelTabs } from "./skill-panel-tabs"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { useSkillsStore } from "@/stores/skills"

// Store-reading: the active tab and unsaved-editor-file count come from
// `useSkillsStore`. Reset between renders; variants seed store state.
const meta = {
  title: "Skills/SkillPanelTabs",
  component: SkillPanelTabs,
  parameters: { layout: "fullscreen" },
  beforeEach: () => {
    resetStore(useSkillsStore)
  },
} satisfies Meta<typeof SkillPanelTabs>

export default meta
type Story = StoryObj<typeof meta>

export const MySkills: Story = {}

export const BrowseActive: Story = {
  beforeEach: () => {
    resetStore(useSkillsStore)
    seedStore(useSkillsStore, { activeTab: "browse" })
  },
}

export const EditorWithDirtyBadge: Story = {
  beforeEach: () => {
    resetStore(useSkillsStore)
    seedStore(useSkillsStore, {
      activeTab: "editor",
      editorWorkspace: {
        activeSkillId: "skill-1",
        activeFileId: "main",
        rightPaneOpen: true,
        openFiles: [
          {
            id: "main",
            kind: "main",
            path: "SKILL.md",
            language: "markdown",
            draftContent: "# Edited body",
            savedContent: "# Original body",
          },
        ],
      },
    })
  },
}

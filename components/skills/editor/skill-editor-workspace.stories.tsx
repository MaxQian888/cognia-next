import type { Meta, StoryObj } from "@storybook/nextjs"

import { SkillEditorWorkspace } from "./skill-editor-workspace"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { useSkillsStore } from "@/stores/skills"
import { seedDb } from "@/lib/storybook/seed-db"
import { makeSkill } from "@/lib/storybook/fixtures/skills"

const SKILL_ID = "story-skill"

// Store + Dexie driven VS Code-style editor tab. Reads `editorWorkspace` from
// `useSkillsStore` and the skill/resources from Dexie; embeds Monaco (loads
// lazily). Empty workspace renders the "no file open" state.
const meta = {
  title: "Skills/Editor/SkillEditorWorkspace",
  component: SkillEditorWorkspace,
  parameters: { layout: "fullscreen" },
  beforeEach: () => {
    resetStore(useSkillsStore)
  },
  decorators: [
    (Story) => (
      <div className="h-[600px] w-full border">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof SkillEditorWorkspace>

export default meta
type Story = StoryObj<typeof meta>

export const NoFileOpen: Story = {}

export const EditingSkillMd: Story = {
  beforeEach: async () => {
    resetStore(useSkillsStore)
    await seedDb(async (db) => {
      await db.skills.put(makeSkill({ id: SKILL_ID, name: "Release Notes Writer" }))
    })
    seedStore(useSkillsStore, {
      editorWorkspace: {
        activeSkillId: SKILL_ID,
        activeFileId: "main",
        rightPaneOpen: true,
        openFiles: [
          {
            id: "main",
            kind: "main",
            path: "SKILL.md",
            language: "markdown",
            draftContent: "# Release Notes\n\nSummarize merged PRs.\n",
            savedContent: "# Release Notes\n\nSummarize merged PRs.\n",
          },
        ],
      },
    })
  },
}

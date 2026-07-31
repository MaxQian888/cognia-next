import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { SkillTabStrip } from "./skill-tab-strip"
import type { EditorFile } from "@/stores/skills/skills-store"

const files: EditorFile[] = [
  {
    id: "main",
    kind: "main",
    path: "SKILL.md",
    language: "markdown",
    draftContent: "# Body (edited)",
    savedContent: "# Body",
  },
  {
    id: "res-1",
    kind: "resource",
    resourceId: "res-1",
    path: "scripts/build.sh",
    language: "shell",
    draftContent: "echo hi",
    savedContent: "echo hi",
  },
]

// Pure props-only tab strip. The first tab is dirty (draft ≠ saved).
const meta = {
  title: "Skills/Editor/SkillTabStrip",
  component: SkillTabStrip,
  parameters: { layout: "fullscreen" },
  args: {
    files,
    activeFileId: "main",
    onSelect: fn(),
    onClose: fn(),
  },
} satisfies Meta<typeof SkillTabStrip>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

export const SingleClean: Story = {
  args: { files: [{ ...files[1], id: "main", path: "SKILL.md" }], activeFileId: "main" },
}

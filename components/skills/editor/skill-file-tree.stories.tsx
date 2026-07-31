import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { SkillFileTree } from "./skill-file-tree"
import { makeSkill, makeSkillResource } from "@/lib/storybook/fixtures/skills"

// Pure props-only file tree for the editor sidebar.
const meta = {
  title: "Skills/Editor/SkillFileTree",
  component: SkillFileTree,
  parameters: { layout: "padded" },
  args: {
    skill: makeSkill({ name: "Release Notes Writer" }),
    resources: [
      makeSkillResource({ kind: "script", name: "build.sh", path: "scripts/build.sh" }),
      makeSkillResource({ kind: "reference", name: "api.md", path: "references/api.md" }),
      makeSkillResource({ kind: "asset", name: "logo.png", path: "assets/logo.png" }),
    ],
    activeFileId: "main",
    onSelect: fn(),
  },
  decorators: [
    (Story) => (
      <div className="w-56 rounded-md border">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof SkillFileTree>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

export const NoResources: Story = {
  args: { resources: [] },
}

import type { Meta, StoryObj } from "@storybook/nextjs"

import { SkillFilePreview } from "./skill-file-preview"
import { makeFileTree } from "@/lib/storybook/fixtures/skills"

// Pure props-only — `files` is a marketplace snapshot manifest, "loading", or
// undefined. The collapsible starts closed; open it to reveal the file list.
const meta = {
  title: "Skills/SkillFilePreview",
  component: SkillFilePreview,
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <div className="max-w-sm">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof SkillFilePreview>

export default meta
type Story = StoryObj<typeof meta>

export const WithFiles: Story = {
  args: { files: makeFileTree() },
}

export const Loading: Story = {
  args: { files: "loading" },
}

export const Empty: Story = {
  args: { files: [] },
}

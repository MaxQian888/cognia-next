import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { SkillMonacoEditor } from "./skill-monaco-editor"

// Props-driven Monaco wrapper. The Monaco runtime loads lazily; until then the
// editor shows its loading state. Theme follows next-themes via the preview.
const meta = {
  title: "Skills/Editor/SkillMonacoEditor",
  component: SkillMonacoEditor,
  parameters: { layout: "fullscreen" },
  args: {
    value: "# Release Notes\n\nSummarize the merged pull requests.\n",
    language: "markdown",
    onChange: fn(),
    skillId: "skill-1",
    documentId: "main",
  },
  decorators: [
    (Story) => (
      <div className="h-[480px] w-full border">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof SkillMonacoEditor>

export default meta
type Story = StoryObj<typeof meta>

export const Markdown: Story = {}

export const ShellReadOnly: Story = {
  args: {
    value: "#!/usr/bin/env bash\nset -euo pipefail\necho 'build'\n",
    language: "shell",
    readOnly: true,
    documentId: "build-sh",
  },
}

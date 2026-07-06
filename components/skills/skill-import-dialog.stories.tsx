import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { SkillImportDialog } from "./skill-import-dialog"
import type { ImportStaging } from "@/stores/skills"

const staging: ImportStaging = {
  sourceLabel: "Markdown files (3)",
  drafts: [
    {
      name: "release-notes",
      description: "Drafts release notes from merged PRs.",
      content: "# Release Notes\n\nSummarize merged PRs.\n",
      tags: ["writing"],
      category: "productivity",
    },
    {
      name: "incident-postmortem",
      description: "Writes a postmortem from an incident timeline.",
      content: "# Postmortem\n",
      category: "productivity",
    },
    {
      name: "api-reviewer",
      content: "# API Reviewer\n",
      category: "development",
    },
  ],
  parseErrors: [{ name: "broken.md", error: "Missing frontmatter name field." }],
  flavor: "anthropic",
}

// Pure props-driven dialog over a staged import set; `onCancel`/`onComplete`
// are spies. Persists through Dexie only on confirm, which the spies intercept.
const meta = {
  title: "Skills/SkillImportDialog",
  component: SkillImportDialog,
  parameters: { layout: "centered" },
  args: {
    staging,
    onCancel: fn(),
    onComplete: fn(),
  },
} satisfies Meta<typeof SkillImportDialog>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

export const SingleDraftNoErrors: Story = {
  args: {
    staging: {
      sourceLabel: "~/.claude/skills/",
      drafts: [staging.drafts[0]],
      parseErrors: [],
    },
  },
}

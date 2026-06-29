import type { Meta, StoryObj } from "@storybook/nextjs"

import { SkillSyncSection } from "./skill-sync-section"
import { makeSkill } from "@/lib/storybook/fixtures/skills"

// Tauri-branching: in the Storybook (web) runtime `isTauri()` is false, so this
// always renders the "desktop only" hint regardless of the skill's sync fields.
// The sync-status variants are documented here but only visible in the desktop
// shell.
const meta = {
  title: "Skills/SkillSyncSection",
  component: SkillSyncSection,
  parameters: { layout: "padded" },
  args: { skill: makeSkill() },
  decorators: [
    (Story) => (
      <div className="max-w-md">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof SkillSyncSection>

export default meta
type Story = StoryObj<typeof meta>

// Web runtime → desktop-only fallback.
export const WebFallback: Story = {}

export const SyncedSkill: Story = {
  args: {
    skill: makeSkill({
      nativeDirectory: "~/.claude/skills/release-notes",
      syncFingerprint: "abc123",
      lastSyncedAt: 1_720_000_000_000,
    }),
  },
}

export const SyncErrorSkill: Story = {
  args: {
    skill: makeSkill({
      nativeDirectory: "~/.claude/skills/release-notes",
      lastSyncError: "Permission denied writing to ~/.claude/skills",
    }),
  },
}

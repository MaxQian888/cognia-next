import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { SkillsBadge } from "./skills-badge"

// Per-session skills toggle, surfaced as a counter badge that opens a popover
// of switches. Click the badge to reveal the toggle list.
const SKILLS = [
  { id: "s1", name: "Release Notes", description: "Summarize merged PRs into release notes." },
  { id: "s2", name: "Code Review", description: "Review a diff for bugs and style." },
  { id: "s3", name: "Translate", description: "Translate text to the target language." },
]

const meta = {
  title: "Chat/SkillsBadge",
  component: SkillsBadge,
  parameters: { layout: "centered" },
  args: {
    skills: SKILLS,
    disabled: new Set<string>(),
    onToggle: fn(async () => {}),
  },
} satisfies Meta<typeof SkillsBadge>

export default meta
type Story = StoryObj<typeof meta>

/** All three skills active. */
export const AllActive: Story = {}

/** One skill switched off for this session — counter reflects the net set. */
export const SomeDisabled: Story = {
  args: { disabled: new Set(["s2"]) },
}

/** Every skill disabled — outline badge variant. */
export const AllDisabled: Story = {
  args: { disabled: new Set(["s1", "s2", "s3"]) },
}

/** Ephemeral skills attached to the next message appear in a read-only section. */
export const WithEphemeralAttachments: Story = {
  args: {
    ephemeralSkills: [
      { id: "e1", name: "Web Search", description: "Search the web for the next reply." },
    ],
  },
}

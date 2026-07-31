import type { Meta, StoryObj } from "@storybook/nextjs"

import { TeamCapabilityOverlaySection } from "./team-capability-overlay-section"
import { emptyEditorState, type PresetEditorState } from "../preset-editor-state"
import type { TeamCapabilityBundle } from "@/types/agent/agent-team"

// Read-only overlay that compares a teammate's effective capabilities against
// the team-level default pool (`teamBundle`). Takes `state` (the teammate
// draft) + an optional `teamBundle`.
const teammate: PresetEditorState = {
  ...emptyEditorState(),
  skillIds: ["skill-research"],
  subagentIds: ["general-purpose"],
}

const teamBundle: TeamCapabilityBundle = {
  skillIds: ["skill-research", "skill-format"],
  subagentIds: ["general-purpose", "code-reviewer"],
  characterPackIds: ["pack-mentor"],
}

const meta = {
  title: "Settings/Presets/EditorSections/TeamCapabilityOverlaySection",
  component: TeamCapabilityOverlaySection,
  parameters: { layout: "padded" },
  args: { state: teammate, defaultOpen: true },
} satisfies Meta<typeof TeamCapabilityOverlaySection>

export default meta
type Story = StoryObj<typeof meta>

// No team bundle supplied → overlay compares against an empty pool.
export const NoTeamPool: Story = {}

// With a team default pool → shows which team capabilities the teammate
// inherits vs overrides.
export const AgainstTeamPool: Story = {
  args: { teamBundle },
}

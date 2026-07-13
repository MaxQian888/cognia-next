import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { ChatPayloadEditor } from "./chat-payload-editor"
import type { ChatLikeDraft } from "./types"
import type { Character, Skill, Team } from "@cognia/agent-config-types"

// Structured editor for chat / agent / skill tasks. The `*ForTesting` props
// bypass the Dexie fetches so the selects render deterministic options.
const CHARACTERS = [
  {
    id: "char-ops",
    name: "Ops Assistant",
    avatarColor: "#3b82f6",
    systemPrompt: "You triage ops.",
  },
  {
    id: "char-writer",
    name: "Doc Writer",
    avatarColor: "#10b981",
    systemPrompt: "You write docs.",
  },
] as Character[]

const SKILLS = [
  { id: "skill-summarize", name: "Summarize Thread", content: "Summarize the conversation." },
  { id: "skill-translate", name: "Translate", content: "Translate to the target language." },
] as Skill[]

const TEAMS = [
  { id: "team-research", name: "Research Pod" },
  { id: "team-ship", name: "Shipping Crew" },
] as Team[]

const meta = {
  title: "Scheduler/PayloadEditors/ChatPayloadEditor",
  component: ChatPayloadEditor,
  parameters: { layout: "padded" },
  args: {
    onDraftChange: fn(),
    testId: "chat-payload-editor",
    charactersForTesting: CHARACTERS,
    skillsForTesting: SKILLS,
    teamsForTesting: TEAMS,
  },
} satisfies Meta<typeof ChatPayloadEditor>

export default meta
type Story = StoryObj<typeof meta>

const EMPTY: ChatLikeDraft = { prompt: "", mcpMode: "default" }

const FILLED: ChatLikeDraft = {
  prompt: "Summarize the overnight activity and post a digest in three bullet points.",
  characterId: "char-ops",
  teamId: "team-research",
  sessionTitle: "Overnight digest",
  agentModeId: null,
  model: "claude-opus-4-8",
  effort: "high",
  maxTurns: 12,
  permissionMode: "acceptEdits",
  allowedTools: ["Read", "Grep", "WebSearch"],
  disallowedTools: ["Bash"],
  mcpMode: "custom",
  mcpServerIds: ["srv-github"],
  additionalDirectories: ["/home/user/projects/cognia"],
  builtinTools: { git: true, process: false },
  appendSystemPrompt: "Always reply in a concise, factual tone.",
}

// Blank chat task — only the required prompt field is empty.
export const EmptyChatDraft: Story = {
  args: { taskType: "chat", draft: EMPTY },
}

// Fully-populated chat task exercising every collapsible section.
export const FilledChatDraft: Story = {
  args: { taskType: "chat", draft: FILLED },
}

// Agent task — character becomes required (asterisk), no team picker.
export const AgentDraft: Story = {
  args: {
    taskType: "agent",
    draft: {
      prompt: "Investigate the failing CI job and propose a fix.",
      characterId: "char-ops",
      mcpMode: "default",
    },
  },
}

// Skill task — exposes the required skill picker in addition to the prompt.
export const SkillDraft: Story = {
  args: {
    taskType: "skill",
    draft: {
      prompt: "Translate the latest release notes to Japanese.",
      skillId: "skill-translate",
      characterId: "char-writer",
      mcpMode: "default",
    },
  },
}

// Validation surfaced for an agent task missing both prompt and character.
export const WithErrors: Story = {
  args: {
    taskType: "agent",
    draft: EMPTY,
    errors: { prompt: "promptRequired", characterId: "characterIdRequired" },
  },
}

// Disabled (read-only) — every control is inert.
export const Disabled: Story = {
  args: { taskType: "chat", draft: FILLED, disabled: true },
}

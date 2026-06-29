import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { ExternalAgentPayloadEditor } from "./external-agent-payload-editor"
import type { ExternalAgentDraft } from "./types"

// Structured editor for `external-agent` tasks. `agentsForTesting` bypasses the
// manager lookup — when non-empty the agentId field is a select (and switching
// agents clamps the permission mode to what the backend supports); when empty it
// falls back to a free-text id input.
const AGENTS = [
  { id: "claude-desktop", name: "Claude Desktop", protocol: "acp" as const },
  { id: "codex-cli", name: "Codex CLI", protocol: "codex-app-server" as const },
  { id: "opencode", name: "OpenCode", protocol: "opencode" as const },
]

const meta = {
  title: "Scheduler/PayloadEditors/ExternalAgentPayloadEditor",
  component: ExternalAgentPayloadEditor,
  parameters: { layout: "padded" },
  args: {
    onDraftChange: fn(),
    testId: "external-agent-payload-editor",
  },
} satisfies Meta<typeof ExternalAgentPayloadEditor>

export default meta
type Story = StoryObj<typeof meta>

const EMPTY: ExternalAgentDraft = { prompt: "", agentId: "" }

// No agents configured → free-text agentId input + help text, empty draft.
export const EmptyFreeText: Story = {
  args: { draft: EMPTY, agentsForTesting: [] },
}

// Agents available → select picker, fully-filled draft.
export const WithAgents: Story = {
  args: {
    draft: {
      prompt: "Review the open PR and leave inline comments on risky changes.",
      agentId: "claude-desktop",
      permissionMode: "acceptEdits",
      cwd: "/home/user/projects/cognia",
      timeoutMs: 600000,
    },
    agentsForTesting: AGENTS,
  },
}

// Codex backend selected → permission-mode list narrows to supported modes.
export const CodexBackend: Story = {
  args: {
    draft: {
      prompt: "Generate a migration script for the new schema version.",
      agentId: "codex-cli",
      permissionMode: "default",
    },
    agentsForTesting: AGENTS,
  },
}

// Submit attempted with blank prompt + agent → inline validation errors.
export const WithErrors: Story = {
  args: {
    draft: EMPTY,
    agentsForTesting: [],
    errors: { prompt: "promptRequired", agentId: "agentIdRequired" },
  },
}

// Disabled (read-only).
export const Disabled: Story = {
  args: {
    draft: {
      prompt: "Summarize the latest commits.",
      agentId: "claude-desktop",
      permissionMode: "plan",
    },
    agentsForTesting: AGENTS,
    disabled: true,
  },
}

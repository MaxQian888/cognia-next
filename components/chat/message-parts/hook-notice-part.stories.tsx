import type { Meta, StoryObj } from "@storybook/nextjs"

import { HookNoticeRow } from "./hook-notice-part"

const meta = {
  title: "Chat/MessageParts/HookNoticePart",
  component: HookNoticeRow,
  parameters: { layout: "padded" },
} satisfies Meta<typeof HookNoticeRow>

export default meta
type Story = StoryObj<typeof meta>

// A PreToolUse hook that blocked an action — destructive bar, expandable reason.
export const Blocked: Story = {
  args: {
    data: {
      type: "hook-notice",
      event: "PreToolUse",
      toolName: "Bash",
      outcome: "blocked",
      block: "Command `rm -rf /` matches a deny rule and was blocked.",
      warnings: [],
    },
  },
}

// A UserPromptSubmit hook that injected extra context — primary bar.
export const ContextInjected: Story = {
  args: {
    data: {
      type: "hook-notice",
      event: "UserPromptSubmit",
      outcome: "context",
      additionalContext:
        "Loaded CLAUDE.md and the active ADR so the model has project conventions before answering.",
      warnings: [],
    },
  },
}

// A PostToolUse hook that emitted warnings — amber bar, warning list.
export const Warning: Story = {
  args: {
    data: {
      type: "hook-notice",
      event: "PostToolUse",
      toolName: "Write",
      outcome: "warning",
      warnings: ["File written outside the workspace root", "No co-located test detected"],
    },
  },
}

// An unknown event id falls back to the raw identifier; no body → not expandable.
export const NoBody: Story = {
  args: {
    data: {
      type: "hook-notice",
      event: "CustomEvent",
      outcome: "context",
      warnings: [],
    },
  },
}

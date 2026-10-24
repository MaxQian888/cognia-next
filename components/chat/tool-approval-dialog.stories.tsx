import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { ToolApprovalDialog } from "./tool-approval-dialog"
import type { PendingApproval } from "@cognia/agent-config-types"

// Tool-aware approval dialog. Shell commands render as a bash block, edit/write
// payloads as a diff/content preview; anything else falls back to a JSON dump.
const approval = (over: Partial<PendingApproval>): PendingApproval => ({
  sessionId: "demo-session",
  requestId: "req-1",
  toolUseID: "tool-1",
  toolName: "mcp__cognia-tools__bash",
  input: {},
  ...over,
})

const meta = {
  title: "Chat/ToolApprovalDialog",
  component: ToolApprovalDialog,
  parameters: { layout: "centered" },
  args: { onRespond: fn() },
} satisfies Meta<typeof ToolApprovalDialog>

export default meta
type Story = StoryObj<typeof meta>

/** A shell command → bash preview. */
export const BashCommand: Story = {
  args: {
    approval: approval({
      title: "Run a shell command?",
      input: {
        command: "pnpm test -- session-cost-badge",
        description: "Run the cost badge tests",
      },
    }),
  },
}

/** An edit payload → diff preview. */
export const EditFile: Story = {
  args: {
    approval: approval({
      toolName: "mcp__cognia-tools__edit",
      title: "Edit lib/utils.ts?",
      input: {
        file_path: "lib/utils.ts",
        old_string: "export function cn(...inputs) {\n  return inputs.join(' ')\n}",
        new_string: "export function cn(...inputs) {\n  return twMerge(clsx(inputs))\n}",
      },
    }),
  },
}

/** A write payload → content preview (diff against empty). */
export const WriteFile: Story = {
  args: {
    approval: approval({
      toolName: "mcp__cognia-tools__write",
      title: "Create a new file?",
      input: { file_path: "notes.md", content: "# Notes\n\n- First idea\n- Second idea\n" },
    }),
  },
}

/** An unknown tool → generic JSON dump. */
export const GenericJson: Story = {
  args: {
    approval: approval({
      toolName: "mcp__some-plugin__do_thing",
      displayName: "do_thing",
      description: "Performs a plugin-defined action.",
      input: { target: "inbox", limit: 25, dryRun: true },
    }),
  },
}

/**
 * An outbound call the policy enforces (ADR-0239): the recipients are named,
 * "allow for this request" replaces "allow always", and deny fences them.
 */
export const OutboundAsk: Story = {
  args: {
    approval: approval({
      toolName: "mcp__cognia-plugin-tools__im_broadcast",
      title: "Send a message to two chats?",
      input: {
        conversationKeys: ["lark:bot-a:oc_release", "lark:bot-a:oc_ops"],
        text: "Release 2.4 is out.",
      },
      suppressAlwaysAllowRule: true,
      requiresPerCallApproval: true,
      defaultToNo: true,
      outbound: {
        enforced: true,
        targets: [
          { kind: "conversation", channel: "bot-a", recipient: "conv:lark:bot-a:oc_release" },
          { kind: "conversation", channel: "bot-a", recipient: "conv:lark:bot-a:oc_ops" },
        ],
        unauthorized: [
          { kind: "conversation", channel: "bot-a", recipient: "conv:lark:bot-a:oc_ops" },
        ],
      },
    }),
  },
}

/** A public link can only be allowed per call: no "allow for this request". */
export const OutboundPublicLink: Story = {
  args: {
    approval: approval({
      toolName: "mcp__cognia-plugin-tools__deploy_site",
      title: "Publish the site?",
      input: { directory: "out" },
      suppressAlwaysAllowRule: true,
      requiresPerCallApproval: true,
      defaultToNo: true,
      outbound: {
        enforced: true,
        targets: [{ kind: "public", channel: "tool:deploy_site", recipient: "public:deploy_site" }],
        unauthorized: [
          { kind: "public", channel: "tool:deploy_site", recipient: "public:deploy_site" },
        ],
      },
    }),
  },
}

/** Null approval → the dialog stays closed. */
export const Closed: Story = {
  args: { approval: null },
}

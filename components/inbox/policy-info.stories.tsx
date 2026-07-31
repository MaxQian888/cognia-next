import type { Meta, StoryObj } from "@storybook/nextjs"

import { PolicyInfo } from "./policy-info"
import type { TriggerPolicy } from "@/types/connectors/policy"

// Pure — the chip renders a tooltip summarising the resolved trigger policy.
// Variants exercise the rule + blocker describe branches.
const meta = {
  title: "Inbox/PolicyInfo",
  component: PolicyInfo,
  parameters: { layout: "padded" },
} satisfies Meta<typeof PolicyInfo>

export default meta
type Story = StoryObj<typeof meta>

export const PrivateDefault: Story = {
  args: {
    policy: {
      rules: [{ kind: "private-default" }],
      blockers: [{ kind: "rate-limit", perUserPerMin: 30, perChannelPerMin: 60 }],
      storeUnmatchedInDraftMode: false,
    } as TriggerPolicy,
  },
}

export const MentionAndKeyword: Story = {
  args: {
    policy: {
      rules: [
        { kind: "self-mention" },
        { kind: "keyword", words: ["help", "support"] },
        { kind: "slash-command", prefixes: ["/ask", "/bot"] },
      ],
      blockers: [
        { kind: "cooldown-after-bot-reply", secs: 15 },
        { kind: "user-blocklist", userIds: ["U999"] },
      ],
      storeUnmatchedInDraftMode: true,
    } as TriggerPolicy,
  },
}

export const NoRules: Story = {
  args: { policy: { rules: [], blockers: [], storeUnmatchedInDraftMode: false } as TriggerPolicy },
}

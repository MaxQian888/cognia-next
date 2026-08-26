import type { Meta, StoryObj } from "@storybook/nextjs"
import { useState } from "react"

import {
  emptyTriggerPolicyDraft,
  toTriggerPolicyDraft,
  type TriggerPolicyDraft,
} from "@/lib/connectors/trigger-policy-draft"
import { addressedOnlyChatPolicy, defaultGroupChatPolicy } from "@/types/connectors/policy"

import { TriggerPolicyEditor } from "./trigger-policy-editor"

/**
 * Controlled by the story so the toggles actually move — the component is
 * presentational and reports every edit to its parent.
 */
function Controlled({ initial }: { initial: TriggerPolicyDraft }) {
  const [draft, setDraft] = useState(initial)
  return <TriggerPolicyEditor value={draft} onChange={setDraft} />
}

const meta = {
  title: "Settings/Connections/TriggerPolicyEditor",
  component: Controlled,
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <div className="max-w-2xl">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof Controlled>

export default meta
type Story = StoryObj<typeof meta>

/** What a bot created today starts from — no diagnostics. */
export const GroupProfile: Story = {
  args: { initial: toTriggerPolicyDraft(defaultGroupChatPolicy()) },
}

/** Deliberately narrow, so the private-scope gap is reported. */
export const AddressedOnly: Story = {
  args: { initial: toTriggerPolicyDraft(addressedOnlyChatPolicy()) },
}

/** Nothing switched on: the bot never answers, and the editor says so. */
export const AnswersNothing: Story = {
  args: { initial: emptyTriggerPolicyDraft() },
}

/** A bot created before the defaults covered both scopes — the repair case. */
export const PrivateOnlyLegacy: Story = {
  args: {
    initial: toTriggerPolicyDraft({
      rules: [{ kind: "private-default" }],
      blockers: [{ kind: "rate-limit", perUserPerMin: 30, perChannelPerMin: 60 }],
      storeUnmatchedInDraftMode: true,
    }),
  },
}

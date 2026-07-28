import type { Meta, StoryObj } from "@storybook/nextjs"

import { DraftNotice } from "./draft-banner"
import { makeConnectorDraft } from "@/lib/storybook/fixtures/inbox"

const CONVERSATION_KEY = "story:conversation"

// A pure presenter handed the one pending draft to surface — `InboxNoticeArea`
// owns the `connectorDrafts` query and mounts this only when a draft exists.
// The Sheet holding `DraftEditor` stays here, so Review opens the editor.
const meta = {
  title: "Inbox/DraftNotice",
  component: DraftNotice,
  args: { conversationKey: CONVERSATION_KEY },
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof DraftNotice>

export default meta
type Story = StoryObj<typeof meta>

export const Pending: Story = {
  args: {
    draft: makeConnectorDraft({ conversationKey: CONVERSATION_KEY, status: "pending" }),
  },
}

export const LongDraft: Story = {
  args: {
    draft: makeConnectorDraft({
      conversationKey: CONVERSATION_KEY,
      status: "pending",
      segments: [
        {
          type: "text",
          text: "Thanks for flagging this — I've pulled the deploy logs for the window you mentioned and there is a matching 502 burst. Sending the full trace over shortly.",
        },
      ],
    }),
  },
}

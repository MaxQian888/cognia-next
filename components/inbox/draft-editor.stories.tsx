import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { DraftEditor } from "./draft-editor"
import { makeConnectorDraft } from "@/lib/storybook/fixtures/inbox"
import type { MessageSegment } from "@/types/connectors/segment"

// Prop-driven: `useDraftApproval` seeds its editable state from `draft.segments`,
// so the editor renders fully from the passed draft without any DB seeding.
// Approve/Reject write to Dexie on click (no-op visually here).
const meta = {
  title: "Inbox/DraftEditor",
  component: DraftEditor,
  args: { onClose: fn() },
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <div className="w-[28rem]">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof DraftEditor>

export default meta
type Story = StoryObj<typeof meta>

export const TextOnly: Story = {
  args: {
    draft: makeConnectorDraft({
      segments: [{ type: "text", text: "Thanks for reaching out — happy to help!" }],
    }),
  },
}

export const MixedSegments: Story = {
  args: {
    draft: makeConnectorDraft({
      segments: [
        { type: "text", text: "Here is the summary you asked for:" },
        { type: "markdown", md: "**Total:** 3 open tickets\n- billing\n- onboarding" },
        { type: "image", url: "https://example.com/chart.png" },
        { type: "file", name: "report.pdf", url: "https://example.com/report.pdf" },
      ] as MessageSegment[],
    }),
  },
}

export const A2uiSurface: Story = {
  args: {
    draft: makeConnectorDraft({
      segments: [
        {
          type: "a2ui",
          surfaceId: "surface-confirm-1",
          plainTextMirror: "Confirm appointment for Tue 10:00? [Yes] [No]",
        },
      ] as MessageSegment[],
    }),
  },
}

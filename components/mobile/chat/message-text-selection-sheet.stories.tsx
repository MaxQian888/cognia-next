import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { MessageTextSelectionSheet } from "./message-text-selection-sheet"
import { makeUIMessage } from "@/lib/storybook/fixtures/mobile"

// "Select text" from the long-press sheet: the message's words as selectable
// text, with the selection actions floating at the foot. Select part of the
// text to see the bar switch from "Whole message" to the passage.
const meta = {
  title: "Mobile/Chat/MessageTextSelectionSheet",
  component: MessageTextSelectionSheet,
  parameters: { layout: "fullscreen", viewport: { defaultViewport: "mobile2" } },
  args: { onOpenChange: fn(), sessionId: "session-1" },
} satisfies Meta<typeof MessageTextSelectionSheet>

export default meta
type Story = StoryObj<typeof meta>

/** A reply long enough to scroll inside the sheet. */
export const Default: Story = {
  args: {
    message: makeUIMessage({
      parts: [
        {
          type: "text",
          text: [
            "The build fails because the lockfile was generated with a newer pnpm than CI runs.",
            "",
            "1. Pin pnpm in `packageManager` so every machine agrees.",
            "2. Regenerate the lockfile with that version and commit it.",
            "3. Rerun the job; the install step should now reuse the cache.",
            "",
            "If it still fails, the cache key probably includes the old lockfile hash — clear the cache once and it will rebuild.",
          ].join("\n"),
        },
      ],
    }),
  },
}

/** Closed: no message chosen yet. */
export const Closed: Story = {
  args: { message: null },
}

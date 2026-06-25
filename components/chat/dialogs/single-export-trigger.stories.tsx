import type { Meta, StoryObj } from "@storybook/nextjs"
import { within, userEvent, waitFor, expect } from "storybook/test"

import { SingleExportTrigger } from "./single-export-trigger"
import type { ChatSession } from "@/lib/claude/types"

// `SingleExportTrigger` is a thin header affordance that opens the
// `SingleExportDialog` for the active session. It renders nothing when there's
// no session. The dialog body (format select, theme/options, share/page
// triggers) is all client-side — Dexie (`getDb()`) is only touched on submit
// or on the share/page sub-actions, so just opening it is safe in Storybook.

const session: ChatSession = {
  id: "demo-session",
  title: "Promise vs async/await 速查",
  characterId: "claude",
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
} as ChatSession

const meta = {
  title: "Chat/Dialogs/SingleExportTrigger",
  component: SingleExportTrigger,
  parameters: { layout: "padded" },
  args: { session },
} satisfies Meta<typeof SingleExportTrigger>

export default meta
type Story = StoryObj<typeof meta>

// Default icon-only trigger (download glyph with tooltip).
export const IconTrigger: Story = {
  args: { variant: "icon" },
}

// Labeled outline button variant.
export const LabeledTrigger: Story = {
  args: { variant: "labeled" },
}

// Trigger clicked — the export dialog opens with format + options controls.
export const DialogOpen: Story = {
  args: { variant: "labeled" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByRole("button", { name: "Export conversation" }))
    await waitFor(() => expect(document.body.textContent).toContain("Export conversation"))
  },
}

// No session — the component renders nothing. Frame intentionally empty.
export const Hidden: Story = {
  args: { session: null },
}

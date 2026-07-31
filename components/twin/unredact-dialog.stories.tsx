import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { UnredactDialog } from "./unredact-dialog"
import { makePlaceholder } from "@/lib/storybook/fixtures/twin"

// Pure props-only dialog — lets the reviewer choose which PII placeholders to
// restore before accepting a draft. `onConfirm` is a spy.
const meta = {
  title: "Twin/UnredactDialog",
  component: UnredactDialog,
  parameters: { layout: "centered" },
  args: {
    open: true,
    onOpenChange: fn(),
    onConfirm: fn(async () => {}),
    placeholders: [
      makePlaceholder({ placeholder: "<EMAIL_001>", original: "alex@example.com", kind: "EMAIL" }),
      makePlaceholder({ placeholder: "<PHONE_001>", original: "+1 555 0100", kind: "PHONE" }),
      makePlaceholder({ placeholder: "<NAME_001>", original: "Alex Kim", kind: "NAME" }),
      makePlaceholder({
        placeholder: "<API_KEY_001>",
        original: "sk-live-abc123",
        kind: "API_KEY",
        keep: false,
      }),
    ],
  },
} satisfies Meta<typeof UnredactDialog>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

export const CustomConfirmLabel: Story = {
  args: { confirmLabel: "Accept 3 drafts" },
}

export const Empty: Story = {
  args: { placeholders: [] },
}

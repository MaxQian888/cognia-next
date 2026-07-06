import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { CharacterPackUpdateDialog } from "./character-pack-update-dialog"

// `CharacterPackUpdateDialog` previews which fields a character-pack update would
// overwrite vs preserve. It loads the diff from Dexie (`previewPackUpdate`); with
// an empty Storybook IndexedDB the preview resolves to none, so the dialog shows
// its "nothing to apply" message. Prop-driven: `open` controls visibility, the
// callbacks are spied with `fn()`.
const meta = {
  title: "Settings/CharacterPackUpdateDialog",
  component: CharacterPackUpdateDialog,
  parameters: { layout: "centered" },
  args: {
    open: true,
    characterId: "char_demo01",
    characterName: "Ada",
    onCancel: fn(),
    onConfirm: fn(),
  },
} satisfies Meta<typeof CharacterPackUpdateDialog>

export default meta
type Story = StoryObj<typeof meta>

// Open with a character that has no available pack update in the empty DB — the
// dialog renders its no-op message and a disabled confirm action.
export const Default: Story = {}

// Closed — the dialog is not mounted in the DOM.
export const Closed: Story = {
  args: { open: false },
}

import type { Meta, StoryObj } from "@storybook/nextjs"

import { FolderPickerButton } from "./folder-picker-button"

// Desktop-only composer button that opens the native directory dialog and adds
// the folder as a reference. It returns null off-desktop, so the stories fake
// the Tauri runtime marker (`__TAURI_INTERNALS__`) so the button renders.
// Clicking opens the native picker, a no-op in Storybook.
const TAURI_MARKER = "__TAURI_INTERNALS__"

function fakeTauri(): () => void {
  const had = TAURI_MARKER in window
  ;(window as unknown as Record<string, unknown>)[TAURI_MARKER] = {}
  return () => {
    if (!had) delete (window as unknown as Record<string, unknown>)[TAURI_MARKER]
  }
}

const meta = {
  title: "Chat/Composer/FolderPickerButton",
  component: FolderPickerButton,
  parameters: { layout: "centered" },
  beforeEach: () => fakeTauri(),
} satisfies Meta<typeof FolderPickerButton>

export default meta
type Story = StoryObj<typeof meta>

/** Desktop runtime — the folder-plus button. Hover for the tooltip. */
export const Default: Story = {}

/** Disabled (e.g. while a turn streams). */
export const Disabled: Story = {
  args: { disabled: true },
}

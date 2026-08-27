import type { Meta, StoryObj } from "@storybook/nextjs"
import { expect, fn, userEvent, within } from "storybook/test"

import { ComposerPlusMenu } from "./composer-plus-menu"

// The mobile composer "+" — a bottom sheet with three groups: a tile grid for
// the media pickers, then rows for what the turn can do and what else it can
// reach. Pure: the attachment callbacks (`onAttach`/`onSend`/`onError`) only
// fire after a native picker resolves, which doesn't happen in the Storybook
// browser, and the typing entries just call `onInsert`. The sheet starts
// closed; the Opened stories drive the toggle.
//
// The `chat.composer.attachMenu` half of the copy is shared with the desktop
// menu, so this file is also where the two are compared side by side.
const meta = {
  title: "Mobile/Chat/ComposerPlusMenu",
  component: ComposerPlusMenu,
  parameters: { layout: "fullscreen" },
  args: {
    onAttach: fn(),
    onSend: fn(),
    onError: fn(),
    onInsert: fn(),
    onOpenExternalServices: fn(),
  },
  decorators: [
    (Story) => (
      <div className="mx-auto flex h-[640px] w-[390px] items-end p-4">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ComposerPlusMenu>

export default meta
type Story = StoryObj<typeof meta>

/** Collapsed — just the `+` toggle in the composer. */
export const Collapsed: Story = {}

/** Opened — the tile grid plus the turn / extend rows. */
export const Opened: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByTestId("composer-plus-toggle"))
    await expect(await within(document.body).findByTestId("composer-plus-menu")).toBeInTheDocument()
  },
}

/**
 * As the chat composer mounts it: voice belongs to the transcription bridge
 * (speech → text), so the sheet's record-as-attachment tile is hidden and the
 * grid is three across.
 */
export const InChatComposer: Story = {
  args: {
    showVoice: false,
    capabilities: (
      <span className="rounded-pill border border-border px-2 py-1 text-xs text-muted-foreground">
        Web search · Skills
      </span>
    ),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByTestId("composer-plus-toggle"))
    await expect(await within(document.body).findByTestId("composer-plus-menu")).toBeInTheDocument()
  },
}

/** The one level of drill-down: `@`-referenceable records, in place. */
export const RecordsSubmenu: Story = {
  args: { showVoice: false },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByTestId("composer-plus-toggle"))
    const body = within(document.body)
    await userEvent.click(await body.findByTestId("composer-plus-records"))
    await expect(await body.findByTestId("composer-plus-back")).toBeInTheDocument()
  },
}

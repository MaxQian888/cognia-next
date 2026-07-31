import type { Meta, StoryObj } from "@storybook/nextjs"
import { expect, fn, userEvent, within } from "storybook/test"

import { ComposerPlusMenu } from "./composer-plus-menu"

// Composer "+" attachment menu (camera / album / file / voice). Pure: the
// callbacks (`onAttach`/`onSend`/`onError`) only fire after a native picker
// resolves, which doesn't happen in the Storybook browser. The popover starts
// closed; the Opened story drives the toggle to reveal the grid.
const meta = {
  title: "Mobile/Chat/ComposerPlusMenu",
  component: ComposerPlusMenu,
  parameters: { layout: "fullscreen" },
  args: { onAttach: fn(), onSend: fn(), onError: fn() },
  decorators: [
    (Story) => (
      <div className="mx-auto flex h-[420px] w-[390px] items-end p-4">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ComposerPlusMenu>

export default meta
type Story = StoryObj<typeof meta>

/** Collapsed — just the paperclip toggle in the composer. */
export const Collapsed: Story = {}

/** Opened — the 3-column attachment grid. */
export const Opened: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const toggle = canvas.getByTestId("composer-plus-toggle")
    await userEvent.click(toggle)
    await expect(await within(document.body).findByTestId("composer-plus-menu")).toBeInTheDocument()
  },
}

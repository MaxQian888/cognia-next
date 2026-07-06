import type { Meta, StoryObj } from "@storybook/nextjs"
import { expect, userEvent, within } from "storybook/test"

import { SelectionCommentButton } from "./selection-comment-button"
import { resetStore } from "@/lib/storybook/seed-stores"
import { useChatStore } from "@/stores/chat"
import { makeArtifact } from "@/lib/storybook/fixtures/artifacts"

// Stages the current text selection inside an artifact (plus a comment) as a
// chat context chip. The trigger opens a popover; with no DOM selection it
// shows the "select some text" empty hint.
const meta = {
  title: "Artifacts/SelectionCommentButton",
  component: SelectionCommentButton,
  args: { artifact: makeArtifact() },
  parameters: { layout: "padded" },
  beforeEach: () => {
    resetStore(useChatStore)
  },
} satisfies Meta<typeof SelectionCommentButton>

export default meta
type Story = StoryObj<typeof meta>

export const Trigger: Story = {}

export const Opened: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(await canvas.findByTestId("selection-comment-trigger"))
    // Popover content portals to the body; the empty hint is shown with no selection.
    await expect(await within(document.body).findByRole("textbox")).toBeVisible()
  },
}

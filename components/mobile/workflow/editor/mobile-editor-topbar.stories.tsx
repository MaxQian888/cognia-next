import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { MobileEditorTopbar } from "./mobile-editor-topbar"
import { createEditorStore } from "@/lib/workflow/editor/store"
import { editorWorkflow } from "@/lib/storybook/fixtures/mobile-workflow-editor"

// Editor chrome: back / name + dirty badge / read·edit toggle / Save / Run /
// overflow menu (undo·redo·auto-layout·fit·snap·history·export·import). Driven
// by a real per-workflow editor store; `reactFlowInstance` is null in the
// story (fit-view is a no-op) since there's no mounted canvas.
const store = createEditorStore(editorWorkflow)

const meta = {
  title: "Mobile/Workflow/Editor/MobileEditorTopbar",
  component: MobileEditorTopbar,
  parameters: { layout: "fullscreen" },
  args: {
    store,
    reactFlowInstance: null,
    mode: "read",
    onToggleMode: fn(),
    onOpenCopilot: fn(),
  },
  decorators: [
    (Story) => (
      <div className="mx-auto w-[390px] border">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof MobileEditorTopbar>

export default meta
type Story = StoryObj<typeof meta>

export const ReadMode: Story = {}

export const EditMode: Story = {
  args: { mode: "edit" },
}

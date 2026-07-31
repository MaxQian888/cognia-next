import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { PresetEditor, emptyEditorState, type PresetEditorState } from "./preset-editor"

// Preset editor orchestrator: composes the Identity / Capability / Tools /
// Advanced collapsible sections and a save/cancel footer. Pure-ish — owns its
// draft state from `initial` and hands the result to `onSave`.
const filled: PresetEditorState = {
  ...emptyEditorState(),
  name: "Senior code reviewer",
  description: "Sharp, terse code-review persona.",
  category: "coding",
  content: "You are a meticulous senior engineer.",
  model: "claude-opus-4",
}

const meta = {
  title: "Settings/Presets/PresetEditor",
  component: PresetEditor,
  parameters: { layout: "padded" },
  args: {
    skillsCatalog: [],
    mcpCatalog: [],
    onCancel: fn(),
    onSave: fn(),
  },
} satisfies Meta<typeof PresetEditor>

export default meta
type Story = StoryObj<typeof meta>

// New preset (empty form).
export const New: Story = {}

// Editing an existing preset (form pre-filled).
export const Editing: Story = {
  args: { initial: filled, submitLabel: "Save changes" },
}

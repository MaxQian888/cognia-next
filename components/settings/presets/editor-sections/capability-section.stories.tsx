import type { Meta, StoryObj } from "@storybook/nextjs"
import { useState } from "react"
import { fn } from "storybook/test"

import { CapabilitySection } from "./capability-section"
import { emptyEditorState, type PresetEditorState } from "../preset-editor-state"

// Capability section: system-prompt content + model + permission mode + effort.
// Controlled via `state` + `onPatch`.
function Harness({ initial }: { initial: PresetEditorState }) {
  const [state, setState] = useState(initial)
  return (
    <div className="max-w-2xl">
      <CapabilitySection
        state={state}
        onPatch={(patch) => setState((prev) => ({ ...prev, ...patch }))}
        defaultOpen
      />
    </div>
  )
}

const meta = {
  title: "Settings/Presets/EditorSections/CapabilitySection",
  component: CapabilitySection,
  parameters: { layout: "padded" },
  args: { state: emptyEditorState(), onPatch: fn() },
} satisfies Meta<typeof CapabilitySection>

export default meta
type Story = StoryObj<typeof meta>

export const Empty: Story = {
  render: () => <Harness initial={emptyEditorState()} />,
}

export const WithContent: Story = {
  render: () => (
    <Harness
      initial={{
        ...emptyEditorState(),
        content: "You are a meticulous senior engineer.",
        model: "claude-opus-4",
        permissionMode: "acceptEdits",
      }}
    />
  ),
}

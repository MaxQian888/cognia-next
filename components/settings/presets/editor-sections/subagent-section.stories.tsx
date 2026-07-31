import type { Meta, StoryObj } from "@storybook/nextjs"
import { useState } from "react"
import { fn } from "storybook/test"

import { SubagentSection } from "./subagent-section"
import { emptyEditorState, type PresetEditorState } from "../preset-editor-state"

// Subagent selector: which subagents the subject may dispatch. Controlled via
// `state` + `onPatch`; writes `subagentIds`. Collapsed by default.
function Harness({ initial }: { initial: PresetEditorState }) {
  const [state, setState] = useState(initial)
  return (
    <div className="max-w-2xl">
      <SubagentSection
        state={state}
        onPatch={(patch) => setState((prev) => ({ ...prev, ...patch }))}
        defaultOpen
      />
    </div>
  )
}

const meta = {
  title: "Settings/Presets/EditorSections/SubagentSection",
  component: SubagentSection,
  parameters: { layout: "padded" },
  args: { state: emptyEditorState(), onPatch: fn() },
} satisfies Meta<typeof SubagentSection>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  render: () => <Harness initial={emptyEditorState()} />,
}

import type { Meta, StoryObj } from "@storybook/nextjs"
import { useState } from "react"
import { fn } from "storybook/test"

import { ExternalPresetSection } from "./external-preset-section"
import { emptyEditorState, type PresetEditorState } from "../preset-editor-state"

// External-agent preset selector (claude-code / codex / …). Single-select
// reads/writes `state.externalAgentPresetId`; multi-select uses `selectedIds` +
// `onPatchMulti`.
function SingleHarness() {
  const [state, setState] = useState<PresetEditorState>(emptyEditorState())
  return (
    <div className="max-w-2xl">
      <ExternalPresetSection
        state={state}
        onPatch={(patch) => setState((prev) => ({ ...prev, ...patch }))}
        defaultOpen
      />
    </div>
  )
}

function MultiHarness() {
  const [ids, setIds] = useState<string[]>([])
  return (
    <div className="max-w-2xl">
      <ExternalPresetSection
        state={emptyEditorState()}
        onPatch={fn()}
        defaultOpen
        multiple
        selectedIds={ids}
        onPatchMulti={setIds}
      />
    </div>
  )
}

const meta = {
  title: "Settings/Presets/EditorSections/ExternalPresetSection",
  component: ExternalPresetSection,
  parameters: { layout: "padded" },
  args: { state: emptyEditorState(), onPatch: fn() },
} satisfies Meta<typeof ExternalPresetSection>

export default meta
type Story = StoryObj<typeof meta>

export const SingleSelect: Story = {
  render: () => <SingleHarness />,
}

export const MultiSelect: Story = {
  render: () => <MultiHarness />,
}

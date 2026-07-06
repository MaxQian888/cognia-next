import type { Meta, StoryObj } from "@storybook/nextjs"
import { useState } from "react"
import { fn } from "storybook/test"

import { CharacterSection } from "./character-section"
import { emptyEditorState, type PresetEditorState } from "../preset-editor-state"

// Character-pack selector. Single-select (preset editor) reads/writes
// `state.characterPackId`; multi-select mode (team pool) uses `selectedIds` +
// `onPatchMulti`. Character packs come from the registry.
function SingleHarness() {
  const [state, setState] = useState<PresetEditorState>(emptyEditorState())
  return (
    <div className="max-w-2xl">
      <CharacterSection
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
      <CharacterSection
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
  title: "Settings/Presets/EditorSections/CharacterSection",
  component: CharacterSection,
  parameters: { layout: "padded" },
  args: { state: emptyEditorState(), onPatch: fn() },
} satisfies Meta<typeof CharacterSection>

export default meta
type Story = StoryObj<typeof meta>

// Single-select character picker.
export const SingleSelect: Story = {
  render: () => <SingleHarness />,
}

// Multi-select checklist (team capability pool).
export const MultiSelect: Story = {
  render: () => <MultiHarness />,
}

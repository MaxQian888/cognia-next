import type { Meta, StoryObj } from "@storybook/nextjs"
import { useState } from "react"
import { fn } from "storybook/test"

import { IdentitySection } from "./identity-section"
import { emptyEditorState, type PresetEditorState } from "../preset-editor-state"

// Identity section of the preset editor: name / icon / color / description /
// category. Controlled via `state` + `onPatch`; the harness holds local state.
function Harness({ initial }: { initial: PresetEditorState }) {
  const [state, setState] = useState(initial)
  return (
    <div className="max-w-2xl">
      <IdentitySection
        state={state}
        onPatch={(patch) => setState((prev) => ({ ...prev, ...patch }))}
        defaultOpen
      />
    </div>
  )
}

const meta = {
  title: "Settings/Presets/EditorSections/IdentitySection",
  component: IdentitySection,
  parameters: { layout: "padded" },
  args: { state: emptyEditorState(), onPatch: fn() },
} satisfies Meta<typeof IdentitySection>

export default meta
type Story = StoryObj<typeof meta>

export const Empty: Story = {
  render: () => <Harness initial={emptyEditorState()} />,
}

export const Filled: Story = {
  render: () => (
    <Harness
      initial={{
        ...emptyEditorState(),
        name: "Senior code reviewer",
        description: "Sharp, terse code-review persona.",
        category: "coding",
      }}
    />
  ),
}

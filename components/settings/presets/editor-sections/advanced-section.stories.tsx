import type { Meta, StoryObj } from "@storybook/nextjs"
import { useState } from "react"
import { fn } from "storybook/test"

import { AdvancedSection } from "./advanced-section"
import { emptyEditorState, type PresetEditorState } from "../preset-editor-state"

// Advanced section: agent mode, working dir, and default/favorite flags.
// Collapsed by default. Controlled via `state` + `onPatch`.
function Harness({ initial }: { initial: PresetEditorState }) {
  const [state, setState] = useState(initial)
  return (
    <div className="max-w-2xl">
      <AdvancedSection
        state={state}
        onPatch={(patch) => setState((prev) => ({ ...prev, ...patch }))}
        defaultOpen
      />
    </div>
  )
}

const meta = {
  title: "Settings/Presets/EditorSections/AdvancedSection",
  component: AdvancedSection,
  parameters: { layout: "padded" },
  args: { state: emptyEditorState(), onPatch: fn() },
} satisfies Meta<typeof AdvancedSection>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  render: () => <Harness initial={emptyEditorState()} />,
}

export const Configured: Story = {
  render: () => (
    <Harness
      initial={{
        ...emptyEditorState(),
        workingDir: "/home/max/projects/demo",
        isDefault: true,
        isFavorite: true,
      }}
    />
  ),
}

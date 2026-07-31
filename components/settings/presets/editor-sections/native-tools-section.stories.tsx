import type { Meta, StoryObj } from "@storybook/nextjs"
import { useState } from "react"
import { fn } from "storybook/test"

import { NativeToolsSection } from "./native-tools-section"
import { emptyEditorState, type PresetEditorState } from "../preset-editor-state"

// Native Anthropic tool selector (e.g. computer-use). Controlled via `state` +
// `onPatch`; writes `nativeAnthropicToolIds`.
function Harness({ initial }: { initial: PresetEditorState }) {
  const [state, setState] = useState(initial)
  return (
    <div className="max-w-2xl">
      <NativeToolsSection
        state={state}
        onPatch={(patch) => setState((prev) => ({ ...prev, ...patch }))}
        defaultOpen
      />
    </div>
  )
}

const meta = {
  title: "Settings/Presets/EditorSections/NativeToolsSection",
  component: NativeToolsSection,
  parameters: { layout: "padded" },
  args: { state: emptyEditorState(), onPatch: fn() },
} satisfies Meta<typeof NativeToolsSection>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  render: () => <Harness initial={emptyEditorState()} />,
}

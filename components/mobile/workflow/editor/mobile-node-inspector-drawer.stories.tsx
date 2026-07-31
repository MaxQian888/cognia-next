import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { MobileNodeInspectorDrawer } from "./mobile-node-inspector-drawer"
import { createEditorStore } from "@/lib/workflow/editor/store"
import { editorWorkflow } from "@/lib/storybook/fixtures/mobile-workflow-editor"
import { DataAdapterProvider } from "@/lib/data-hooks/context"
import type { DataAdapter } from "@/lib/data-hooks/types"

// Vaul snap drawer that embeds the desktop `InspectorPanel` for the selected
// node. The inspector reads characters / presets / skills through the
// data-hooks adapter, so the story supplies an empty mock (same pattern as the
// desktop EditorCanvas story). A node is pre-selected so the panel has content.
const mockAdapter: DataAdapter = {
  useCharacters: () => [],
  useCharacter: () => undefined,
  useSkillsByIds: () => [],
  usePresets: () => [],
  clearMessages: async () => {},
  updateSession: async () => {},
  recordPresetUsage: async () => {},
  trustWorkspace: async () => {},
}

const store = createEditorStore(editorWorkflow)
store.getState().setSelectedNodes(["n_summarize"])

const meta = {
  title: "Mobile/Workflow/Editor/MobileNodeInspectorDrawer",
  component: MobileNodeInspectorDrawer,
  parameters: { layout: "fullscreen" },
  args: { open: true, onOpenChange: fn(), store, canConnect: true, onStartConnect: fn() },
  decorators: [
    (Story) => (
      <DataAdapterProvider adapter={mockAdapter}>
        <Story />
      </DataAdapterProvider>
    ),
  ],
} satisfies Meta<typeof MobileNodeInspectorDrawer>

export default meta
type Story = StoryObj<typeof meta>

export const Open: Story = {}

export const ReadOnly: Story = {
  args: { canConnect: false },
}

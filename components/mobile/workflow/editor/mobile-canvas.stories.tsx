import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"
import { ReactFlowProvider } from "@xyflow/react"

import { MobileCanvas } from "./mobile-canvas"
import { createEditorStore } from "@/lib/workflow/editor/store"
import { editorWorkflow } from "@/lib/storybook/fixtures/mobile-workflow-editor"
import { DataAdapterProvider } from "@/lib/data-hooks/context"
import type { DataAdapter } from "@/lib/data-hooks/types"

// Mobile-tuned React Flow surface (touch pan / pinch / tap-to-inspect). Reuses
// the desktop node + edge renderers. Needs a sized host and a ReactFlowProvider
// (its parent editor normally supplies one). Run-status decoration resolves
// empty off-Dexie; the orientation lock no-ops off the Capacitor shell.
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

const meta = {
  title: "Mobile/Workflow/Editor/MobileCanvas",
  component: MobileCanvas,
  parameters: { layout: "fullscreen" },
  args: {
    store,
    mode: "read",
    connectActive: false,
    onNodeTap: fn(),
    onEdgeTap: fn(),
    onPaneTap: fn(),
    orientationLocked: true,
    onLongPress: fn(),
    onInit: fn(),
  },
  decorators: [
    (Story) => (
      <DataAdapterProvider adapter={mockAdapter}>
        <ReactFlowProvider>
          <div className="h-[640px] w-[390px]">
            <Story />
          </div>
        </ReactFlowProvider>
      </DataAdapterProvider>
    ),
  ],
} satisfies Meta<typeof MobileCanvas>

export default meta
type Story = StoryObj<typeof meta>

export const ReadMode: Story = {}

export const EditMode: Story = {
  args: { mode: "edit" },
}

export const Connecting: Story = {
  args: { mode: "edit", connectActive: true },
}

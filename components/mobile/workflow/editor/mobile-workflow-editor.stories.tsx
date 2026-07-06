import type { Meta, StoryObj } from "@storybook/nextjs"

import { MobileWorkflowEditor } from "./mobile-workflow-editor"
import { editorWorkflow } from "@/lib/storybook/fixtures/mobile-workflow-editor"
import { DataAdapterProvider } from "@/lib/data-hooks/context"
import type { DataAdapter } from "@/lib/data-hooks/types"

// The full touch-first editor: top bar + React Flow canvas + node palette FAB
// + inspector drawer. Self-contained (builds its own per-workflow store and
// wraps itself in ReactFlowProvider) — it only needs a workflow. The embedded
// inspector reads through the data-hooks adapter, so the story supplies an
// empty mock.
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

const meta = {
  title: "Mobile/Workflow/Editor/MobileWorkflowEditor",
  component: MobileWorkflowEditor,
  parameters: { layout: "fullscreen" },
  args: { workflow: editorWorkflow },
  decorators: [
    (Story) => (
      <DataAdapterProvider adapter={mockAdapter}>
        <div className="mx-auto h-[760px] w-[390px] overflow-hidden border">
          <Story />
        </div>
      </DataAdapterProvider>
    ),
  ],
} satisfies Meta<typeof MobileWorkflowEditor>

export default meta
type Story = StoryObj<typeof meta>

export const Populated: Story = {}

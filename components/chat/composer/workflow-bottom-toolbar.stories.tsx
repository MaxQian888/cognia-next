import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { WorkflowBottomToolbar } from "./workflow-bottom-toolbar"
import {
  WorkflowEditorProvider,
  type WorkflowEditorContextValue,
} from "@/lib/workflow/editor/workflow-editor-context"
import { createEditorStore } from "@/lib/workflow/editor/store"
import { useSettingsStore } from "@/stores/settings"
import type { AppSettings, ChatSession } from "@/lib/claude/types"
import type { VisualWorkflow } from "@/types/workflow/visual"

// WorkflowBottomToolbar is the workflow-editor variant of the composer toolbar:
// ModelPicker + PermissionModeIndicator + three workflow quick actions
// (Validate / Explain / Suggest), gauge pinned right. The quick actions read
// `selectedNodeIds` off a real per-editor store via `useWorkflowEditor()`, so
// every story wraps it in a `WorkflowEditorProvider`. Explain self-disables
// when the selection is empty.

const seedSettings = async () => {
  useSettingsStore.setState({
    settings: {
      defaultModel: "claude-sonnet-4-5",
      defaultProvider: "anthropic",
      providerSettings: {},
      customProviders: [],
    } as unknown as AppSettings,
  })
}

function makeWorkflow(): VisualWorkflow {
  return {
    id: "wf_demo",
    schemaVersion: 1,
    name: "Lead intake",
    nodes: [
      {
        id: "n1",
        type: "trigger.manual",
        typeVersion: 1,
        position: { x: 0, y: 0 },
        data: { label: "Manual trigger", params: {} },
      },
      {
        id: "n2",
        type: "ai.prompt",
        typeVersion: 1,
        position: { x: 240, y: 0 },
        data: { label: "Draft reply", params: {} },
      },
    ],
    edges: [],
    settings: {
      errorPolicy: "stop",
      timeoutMs: 60_000,
      concurrency: 1,
      retryDefaults: { attempts: 3, backoff: "exponential", baseMs: 1000, maxMs: 30_000 },
    },
    tags: [],
    createdAt: 0,
    updatedAt: 0,
  }
}

const session: ChatSession = {
  id: "workflow:wf_demo",
  title: "Lead intake",
  kind: "workflow-editor",
  model: "claude-sonnet-4-5",
  providerOverride: "anthropic",
} as ChatSession

function withProvider(selectedNodeIds: string[]) {
  return function Decorator(Story: () => React.ReactElement) {
    const store = createEditorStore(makeWorkflow())
    store.getState().setSelectedNodes(selectedNodeIds)
    const ctx: WorkflowEditorContextValue = {
      useEditorStore: store,
      onQuickAction: fn(),
    }
    return (
      <WorkflowEditorProvider value={ctx}>
        <div className="w-full max-w-2xl rounded-md border p-2">
          <Story />
        </div>
      </WorkflowEditorProvider>
    )
  }
}

const meta = {
  title: "Chat/Composer/WorkflowBottomToolbar",
  component: WorkflowBottomToolbar,
  parameters: { layout: "padded" },
  beforeEach: seedSettings,
  args: { session },
} satisfies Meta<typeof WorkflowBottomToolbar>

export default meta
type Story = StoryObj<typeof meta>

// No nodes selected → Validate and Suggest are live, Explain is disabled.
export const NoSelection: Story = {
  decorators: [withProvider([])],
}

// A node selected → all three quick actions (Validate / Explain / Suggest) live.
export const WithSelection: Story = {
  decorators: [withProvider(["n2"])],
}

import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { WorkflowEditorCanvas } from "./canvas"
import { DataAdapterProvider } from "@/lib/data-hooks/context"
import type { DataAdapter } from "@/lib/data-hooks/types"
import type { VisualWorkflow } from "@/types/workflow/visual"

// The editor chrome (right inspector, node config forms) reads characters /
// presets / skills through the data-hooks adapter; supply an empty mock so it
// renders without the app-root provider.
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

// The full editor page: node-search sidebar · React Flow canvas (toolbar,
// minimap, background) · right inspector sidebar. `WorkflowEditorCanvas` is
// self-contained — it builds its own per-workflow editor store and wraps
// itself in ReactFlowProvider, so a story only needs to hand it a workflow.
// Dexie-backed live data (run-status bridge, last-run summaries) resolves to
// empty in the browser, so the canvas renders its authored graph cleanly.

const createdAt = 1_700_000_000_000

const baseSettings = {
  errorPolicy: "stop" as const,
  timeoutMs: 60_000,
  concurrency: 1,
  retryDefaults: { attempts: 2, backoff: "exponential" as const, baseMs: 500 },
}

const populated: VisualWorkflow = {
  id: "wf_canvas_demo",
  schemaVersion: 2,
  name: "Triage inbound message",
  createdAt,
  updatedAt: createdAt,
  // Seed the camera so the authored nodes sit in view (the canvas does not
  // auto-fit — fitView is disabled to keep the controlled store authoritative).
  viewport: { x: 60, y: 80, zoom: 0.85 },
  nodes: [
    {
      id: "n_trigger",
      type: "trigger.manual",
      typeVersion: 1,
      position: { x: 0, y: 120 },
      data: { label: "When triggered", params: {} },
    },
    {
      id: "n_summarize",
      type: "action.agent.turn",
      typeVersion: 1,
      position: { x: 320, y: 40 },
      data: { label: "Summarize thread", params: {} },
    },
    {
      id: "n_wait",
      type: "flow.wait",
      typeVersion: 1,
      position: { x: 320, y: 220 },
      data: { label: "Wait 30s", params: { durationMs: 30_000 } },
    },
    {
      id: "n_reply",
      type: "action.character.send",
      typeVersion: 1,
      position: { x: 660, y: 120 },
      data: { label: "Send reply", params: {} },
    },
  ],
  edges: [
    { id: "e1", source: "n_trigger", target: "n_summarize" },
    { id: "e2", source: "n_trigger", target: "n_wait" },
    { id: "e3", source: "n_summarize", target: "n_reply" },
    { id: "e4", source: "n_wait", target: "n_reply" },
  ],
  settings: baseSettings,
}

const blank: VisualWorkflow = {
  id: "wf_canvas_blank",
  schemaVersion: 2,
  name: "Untitled workflow",
  createdAt,
  updatedAt: createdAt,
  nodes: [],
  edges: [],
  settings: baseSettings,
}

const meta = {
  title: "Workflow/EditorCanvas",
  component: WorkflowEditorCanvas,
  parameters: { layout: "fullscreen" },
  // React Flow needs a sized host — the component is `h-full w-full`.
  decorators: [
    (Story) => (
      <DataAdapterProvider adapter={mockAdapter}>
        <div className="h-[640px] w-full">{Story()}</div>
      </DataAdapterProvider>
    ),
  ],
  args: { onRequestRun: fn() },
} satisfies Meta<typeof WorkflowEditorCanvas>

export default meta
type Story = StoryObj<typeof meta>

// A populated graph: trigger → summarize / wait → reply, with the full editor
// chrome (left palette, canvas toolbar, minimap, right inspector).
export const Populated: Story = {
  args: { workflow: populated },
}

// A brand-new workflow — the canvas shows the empty-state overlay alongside
// the sidebars and toolbar.
export const Empty: Story = {
  args: { workflow: blank },
}

// A populated `VisualWorkflow` for the mobile workflow-editor stories
// (top bar / canvas / inspector drawer / full editor). Mirrors the shape the
// desktop `Workflow/EditorCanvas` story uses so the authored graph renders
// with real nodes + edges. The editor store is built from this via
// `createEditorStore`; Dexie-backed run state resolves empty in Storybook.
import { DEFAULT_WORKFLOW_SETTINGS, type VisualWorkflow } from "@/types/workflow/visual"

const CREATED_AT = 1_700_000_000_000

/** Trigger → summarize / wait → reply — four nodes, four edges. */
export const editorWorkflow: VisualWorkflow = {
  id: "wf_mobile_editor_demo",
  schemaVersion: 2,
  name: "Triage inbound message",
  createdAt: CREATED_AT,
  updatedAt: CREATED_AT,
  viewport: { x: 40, y: 60, zoom: 0.8 },
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
      position: { x: 280, y: 40 },
      data: { label: "Summarize thread", params: {} },
    },
    {
      id: "n_wait",
      type: "flow.wait",
      typeVersion: 1,
      position: { x: 280, y: 220 },
      data: { label: "Wait 30s", params: { durationMs: 30_000 } },
    },
    {
      id: "n_reply",
      type: "action.character.send",
      typeVersion: 1,
      position: { x: 580, y: 120 },
      data: { label: "Send reply", params: {} },
    },
  ],
  edges: [
    { id: "e1", source: "n_trigger", target: "n_summarize" },
    { id: "e2", source: "n_trigger", target: "n_wait" },
    { id: "e3", source: "n_summarize", target: "n_reply" },
    { id: "e4", source: "n_wait", target: "n_reply" },
  ],
  settings: { ...DEFAULT_WORKFLOW_SETTINGS },
}

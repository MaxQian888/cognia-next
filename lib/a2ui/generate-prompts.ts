/**
 * The instructions an A2UI generation turn sends (ADR-0236).
 *
 * A leaf module so the Prompt Center catalog can list them without loading
 * the generation runtime (`ai-generate.ts` pulls in build-options and the
 * stores); `ai-generate.ts` resolves them per turn, as the agent the
 * generation runs as when the hub composer picked one.
 */

import { definePrompt } from "@/lib/prompts/types"

/** Both prompts resolve in `buildPrompt` of the generation runtime. */
const A2UI_GENERATE_CONSUMERS = ["lib/a2ui/ai-generate.ts"] as const
/** A component tree fed as edit context is uncapped today; far above any real app. */
const COMPONENTS_JSON_MAX = 2_000_000

/**
 * The instruction for a whole-app build (ADR-0236). `{{surfaceId}}` is the
 * surface the editor binds; `{{language}}` is "Chinese" or "English".
 */
export const A2UI_CREATE_APP_PROMPT = definePrompt({
  id: "generation.a2ui.create-app",
  contractVersion: 1,
  kind: "feature-template",
  group: "generation",
  operation: "replace-template",
  scopes: ["account", "agent"],
  activation: "next-operation",
  // The surface is captured from the a2ui-bridge tool calls this text asks for.
  risk: "protocol",
  hosts: ["app"],
  maxChars: 8_000,
  variables: [
    { name: "instruction", required: true, maxChars: 200_000 },
    { name: "surfaceId", required: true, maxChars: 1_000 },
    { name: "language", required: false, maxChars: 32 },
  ],
  requiredFragments: ["a2ui_create_surface", "a2ui_update_components"],
  outputContract:
    "Sent as the user turn of a headless A2UI generation; the first surface the turn's a2ui-bridge tool calls create is applied to the editor, and a turn that creates none falls back to the template generator.",
  consumers: A2UI_GENERATE_CONSUMERS,
  defaultBody: [
    "Build a complete, self-contained, interactive A2UI mini-app for this request: {{instruction}}",
    'Use the a2ui-bridge tools in this order: a2ui_create_surface with surfaceId "{{surfaceId}}" and surfaceType "inline"; then a2ui_update_components with the full component tree; then a2ui_data_model_update with the initial data model. Wire buttons and inputs so the app is usable.',
    "All user-facing labels, titles and copy MUST be in {{language}}.",
  ].join("\n\n"),
})

/**
 * The instruction for an incremental edit of an existing app (ADR-0236).
 * `{{currentComponents}}` is empty, or a blank-line-led "Current components
 * (JSON)" block the host renders from the live tree.
 */
export const A2UI_EDIT_APP_PROMPT = definePrompt({
  id: "generation.a2ui.edit-app",
  contractVersion: 1,
  kind: "feature-template",
  group: "generation",
  operation: "replace-template",
  scopes: ["account", "agent"],
  activation: "next-operation",
  // Patches are captured from the a2ui-bridge tool calls this text asks for.
  risk: "protocol",
  hosts: ["app"],
  maxChars: 8_000,
  variables: [
    { name: "instruction", required: true, maxChars: 200_000 },
    { name: "surfaceId", required: true, maxChars: 1_000 },
    { name: "currentComponents", required: false, maxChars: COMPONENTS_JSON_MAX },
    { name: "language", required: false, maxChars: 32 },
  ],
  requiredFragments: ["a2ui_update_components"],
  outputContract:
    "Sent as the user turn of a headless A2UI edit; the a2ui-bridge patches stream onto the live surface and the captured tree reconciles it. An edit that yields no surface leaves the app untouched.",
  consumers: A2UI_GENERATE_CONSUMERS,
  defaultBody: [
    'You are editing an existing A2UI mini-app (surfaceId "{{surfaceId}}").',
    'Apply the requested change using the a2ui-bridge tools: call a2ui_update_components (and a2ui_data_model_update if data changes) on surfaceId "{{surfaceId}}". Do NOT call a2ui_create_surface — the surface already exists. Emit only the components that change; leave the rest intact.{{currentComponents}}',
    "Change request: {{instruction}}",
    "All user-facing labels, titles and copy MUST be in {{language}}.",
  ].join("\n\n"),
})

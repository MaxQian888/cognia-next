// The `ask_user` tool — lets the agent pause mid-task and ask the user a
// structured question (single/multi choice and/or free text), blocking until
// they answer. OpenCode-style elicitation.
//
// It rides the EXISTING plugin-tool round-trip (no sidecar/Rust changes): a
// manifest entry surfaces it to the sidecar's `cognia-plugin-tools` MCP
// server, the model's call comes back as a `plugin_tool_exec` event, and
// `handlePluginToolExec` routes the `ask_user` name to the renderer's
// ask-user dialog controller, which resolves with the formatted answer.

import type { PluginToolManifestEntry } from "@/lib/plugin/bridge/sidecar-tools-bridge"

export const ASK_USER_TOOL_NAME = "ask_user"

/** Synthetic plugin id namespacing the tool in the manifest / audit trail. */
export const ASK_USER_PLUGIN_ID = "cognia-ask-user"

/** A selectable choice offered to the user. */
export interface AskUserOption {
  value: string
  label: string
}

/** Parsed `ask_user` tool input (model-supplied). */
export interface AskUserRequest {
  question: string
  options: AskUserOption[]
  multiSelect: boolean
  allowText: boolean
}

/** The user's answer, handed back to the model as the tool result. */
export interface AskUserAnswer {
  /** Values of the selected options (empty when none / text-only). */
  selected: string[]
  /** Free-text answer (empty when not provided). */
  text: string
  /** True when the user dismissed the prompt without answering. */
  cancelled: boolean
}

export const ASK_USER_SCHEMA = {
  type: "object",
  properties: {
    question: {
      type: "string",
      description: "The question to ask the user.",
    },
    options: {
      type: "array",
      description: "Optional choices for the user to pick from.",
      items: {
        type: "object",
        properties: {
          value: { type: "string", description: "Machine value returned on selection." },
          label: { type: "string", description: "Human-readable choice label." },
        },
        required: ["value", "label"],
      },
    },
    multiSelect: {
      type: "boolean",
      description: "Allow selecting more than one option (checkboxes instead of radios).",
    },
    allowText: {
      type: "boolean",
      description: "Also let the user type a free-text answer.",
    },
  },
  required: ["question"],
} as const

/** The manifest entry that surfaces `ask_user` to the sidecar tool server. */
export function buildAskUserManifestEntry(): PluginToolManifestEntry {
  return {
    name: ASK_USER_TOOL_NAME,
    description:
      "Pause and ask the user a question, then wait for their answer. Provide `options` for a choice prompt (set `multiSelect` for several), and/or `allowText` for free text. Use when you need a decision or missing information you cannot infer.",
    jsonSchema: ASK_USER_SCHEMA as unknown as object,
    pluginId: ASK_USER_PLUGIN_ID,
    // The user may take an arbitrarily long time to answer — disable the
    // sidecar's 120s round-trip timeout so the question never gets severed
    // mid-prompt. The renderer dialog always resolves (answer or cancel).
    timeoutMs: 0,
  }
}

/**
 * Normalize raw model-supplied args into a well-formed request. Drops
 * malformed options, coerces flags, and guarantees a non-empty question
 * string so the dialog never renders blank.
 */
export function parseAskUserArgs(args: Record<string, unknown>): AskUserRequest {
  const question = typeof args.question === "string" ? args.question.trim() : ""
  const rawOptions = Array.isArray(args.options) ? args.options : []
  const options: AskUserOption[] = []
  for (const o of rawOptions) {
    if (!o || typeof o !== "object") continue
    const value = (o as { value?: unknown }).value
    const label = (o as { label?: unknown }).label
    if (typeof value !== "string") continue
    options.push({ value, label: typeof label === "string" && label ? label : value })
  }
  return {
    question: question || "(no question provided)",
    options,
    multiSelect: args.multiSelect === true,
    // Default to free text when no options are offered — otherwise the user
    // would have nothing to answer with.
    allowText: args.allowText === true || options.length === 0,
  }
}

/**
 * Render the answer as the plain-text tool result the model reads. Labels are
 * preferred over raw values for readability; falls back to the value.
 */
export function formatAskUserAnswer(request: AskUserRequest, answer: AskUserAnswer): string {
  if (answer.cancelled) return "The user dismissed the question without answering."
  const parts: string[] = []
  if (answer.selected.length > 0) {
    const labels = answer.selected.map(
      (v) => request.options.find((o) => o.value === v)?.label ?? v
    )
    parts.push(`Selected: ${labels.join(", ")}`)
  }
  if (answer.text.trim()) parts.push(`Answer: ${answer.text.trim()}`)
  return parts.length > 0 ? parts.join("\n") : "The user submitted an empty answer."
}

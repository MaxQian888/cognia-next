import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import type { ParameterDefinition } from "@cognia/provider-types"
import { DynamicParameterForm } from "./dynamic-parameter-form"

// Schema-driven parameter form: renders one control per `ParameterDefinition`
// (slider / select / number / toggle / text / json). Labels here are plain
// strings (not `providerParams.*` keys), so the component's `tKey` helper
// echoes them verbatim — no i18n lookups required. Pure props.

const PARAMETERS: ParameterDefinition[] = [
  {
    key: "temperature",
    type: "slider",
    label: "Temperature",
    description: "Higher values make output more random.",
    category: "inference",
    defaultValue: 0.7,
    validation: { min: 0, max: 2, step: 0.1 },
  },
  {
    key: "maxTokens",
    type: "number",
    label: "Max tokens",
    description: "Upper bound on generated tokens.",
    category: "inference",
    defaultValue: 2048,
    validation: { min: 1, max: 32768 },
  },
  {
    key: "reasoningEffort",
    type: "select",
    label: "Reasoning effort",
    description: "Trade latency for deeper reasoning.",
    category: "advanced",
    defaultValue: "medium",
    validation: {
      options: [
        { value: "low", label: "Low" },
        { value: "medium", label: "Medium" },
        { value: "high", label: "High" },
      ],
    },
  },
  {
    key: "stream",
    type: "toggle",
    label: "Stream responses",
    description: "Emit tokens incrementally.",
    category: "connection",
    defaultValue: true,
  },
  {
    key: "systemPromptSuffix",
    type: "text",
    label: "System prompt suffix",
    description: "Appended to every system prompt.",
    category: "advanced",
    defaultValue: "",
  },
  {
    key: "providerOptions",
    type: "json",
    label: "Raw provider options",
    description: "Merged verbatim into the request body.",
    category: "advanced",
    defaultValue: "{}",
  },
]

const meta = {
  title: "Settings/Provider/DynamicParameterForm",
  component: DynamicParameterForm,
  parameters: { layout: "padded" },
  args: {
    parameters: PARAMETERS,
    values: {
      temperature: 0.9,
      maxTokens: 4096,
      reasoningEffort: "high",
      stream: true,
      systemPromptSuffix: "Be concise.",
      providerOptions: '{\n  "logprobs": true\n}',
    },
    onChange: fn(),
  },
} satisfies Meta<typeof DynamicParameterForm>

export default meta
type Story = StoryObj<typeof meta>

// Every control type with populated values.
export const AllControls: Story = {}

// Only the inference-category parameters via `filterCategory`.
export const InferenceOnly: Story = {
  args: {
    filterCategory: "inference",
  },
}

// Source badges (session / provider / global) shown next to each control.
export const WithSourceBadges: Story = {
  args: {
    sourceLabels: {
      temperature: "session",
      maxTokens: "provider",
      reasoningEffort: "global",
    },
  },
}

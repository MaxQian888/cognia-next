import type { Meta, StoryObj } from "@storybook/nextjs"
import { useState } from "react"
import { fn } from "storybook/test"

import { ModelOverrideFields, type ProviderOption } from "./model-override-fields"
import type { UtilityModelConfig } from "@/lib/claude/types"

// Pure props: a provider select (configured providers + "use chat default")
// plus a free-text model id. Used by conversation-title / timeline-label /
// pet-speak utility-model configs. The stories keep local state so the select
// and input behave interactively.
const PROVIDERS: ProviderOption[] = [
  { id: "anthropic", name: "Anthropic" },
  { id: "openai", name: "OpenAI" },
  { id: "deepseek", name: "DeepSeek" },
]

const LABELS = { provider: "Provider", model: "Model", useDefault: "Use chat default" }

function Harness({ initial }: { initial: UtilityModelConfig | undefined }) {
  const [value, setValue] = useState<UtilityModelConfig | undefined>(initial)
  return (
    <div className="max-w-lg">
      <ModelOverrideFields
        value={value}
        providers={PROVIDERS}
        labels={LABELS}
        onChange={(patch) => setValue((prev) => ({ ...prev, ...patch }))}
      />
    </div>
  )
}

const meta = {
  title: "Settings/Common/ModelOverrideFields",
  component: ModelOverrideFields,
  parameters: { layout: "padded" },
  args: { providers: PROVIDERS, labels: LABELS, onChange: fn(), value: undefined },
} satisfies Meta<typeof ModelOverrideFields>

export default meta
type Story = StoryObj<typeof meta>

// No override → provider falls back to "use chat default", model blank.
export const UseDefault: Story = {
  render: () => <Harness initial={undefined} />,
}

// An explicit provider + model override.
export const WithOverride: Story = {
  render: () => <Harness initial={{ providerOverride: "openai", model: "gpt-4o-mini" }} />,
}

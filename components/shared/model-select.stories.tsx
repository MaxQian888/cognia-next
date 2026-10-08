import type { Meta, StoryObj } from "@storybook/nextjs"
import { RefreshCw } from "lucide-react"

import { Button } from "@/components/ui/button"
import { useSettingsStore } from "@/stores/settings"
import type { AppSettings } from "@cognia/agent-config-types"
import { ModelSelect } from "./model-select"

// The shared picker as an external agent's lane draws it: the agent's own
// catalog as the only group, headed by the agent's name with a refresh action,
// and each row wearing the capabilities the agent's catalog reported.
const seedEmptyProviders = async () => {
  useSettingsStore.setState({
    settings: { providerSettings: {}, customProviders: [] } as unknown as AppSettings,
  })
}

const refresh = (
  <Button
    type="button"
    variant="ghost"
    size="sm"
    className="h-6 gap-1.5 px-1.5 text-xs font-normal"
  >
    <RefreshCw className="size-3" />
    Refresh models
  </Button>
)

const meta = {
  title: "Shared/ModelSelect",
  component: ModelSelect,
  parameters: { layout: "padded" },
  beforeEach: seedEmptyProviders,
} satisfies Meta<typeof ModelSelect>

export default meta
type Story = StoryObj<typeof meta>

export const ExternalAgentCatalog: Story = {
  args: {
    model: "deepseek/deepseek-flash",
    provider: "cognia:external-agent:pi",
    onSelect: () => {},
    hideProviderGroups: true,
    leadingNotice: "The model you pick is applied on the next message.",
    leadingGroups: [
      {
        providerId: "cognia:external-agent:pi",
        providerName: "Pi (native RPC)",
        headingAction: refresh,
        models: [
          {
            id: "deepseek/deepseek-flash",
            name: "DeepSeek V4.1 Flash",
            contextLength: 1_000_000,
            supportsVision: true,
            supportsReasoning: true,
          },
          {
            id: "deepseek/deepseek-v4-pro",
            name: "DeepSeek V4 Pro",
            contextLength: 1_000_000,
            supportsReasoning: true,
          },
          {
            id: "cpa/gpt-5.5",
            name: "gpt-5.5",
            contextLength: 400_000,
            supportsVision: true,
            supportsReasoning: true,
          },
          { id: "cpa/legacy", name: "legacy (nothing reported)" },
        ],
      },
    ],
  },
}

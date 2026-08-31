import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { DiscoverInspector } from "./discover-inspector"
import type { DiscoverItem } from "@/hooks/discover/use-discover-query"

// Right rail for the desktop discover page. No selection → per-category
// overview; a selection → focused per-kind detail panel.
const item = (raw: { kind: string; id: string; data: Record<string, unknown> }): DiscoverItem =>
  raw as unknown as DiscoverItem

const items: DiscoverItem[] = [
  item({
    kind: "character",
    id: "c1",
    data: { name: "Ada", description: "Senior engineer persona.", isBuiltIn: true },
  }),
  item({
    kind: "skill",
    id: "s1",
    data: { name: "PDF reading", description: "Extract text from PDFs.", status: "enabled" },
  }),
  item({
    kind: "docsProvider",
    id: "lark",
    data: {
      id: "lark",
      mentionPrefix: "lark:",
      kinds: ["doc", "wiki", "sheet", "bitable"],
      hosts: ["tauri"],
    },
  }),
  item({
    kind: "externalService",
    id: "figma-external-service:figma",
    data: {
      key: "figma-external-service:figma",
      pluginId: "figma-external-service",
      serviceId: "figma",
      label: "Figma",
      description: "Design context, canvas editing, Code Connect, assets and prompts.",
      icon: "🎨",
      skillIds: ["figma-use", "figma-design-to-code"],
      providers: [
        {
          providerId: "remote",
          kind: "mcp",
          availability: "vendor-pending",
          surfaces: ["chat"],
          priority: 100,
          connection: null,
          state: "not-connected",
          action: { kind: "blocked-upstream" },
        },
        {
          providerId: "desktop",
          kind: "mcp",
          availability: "supported",
          surfaces: ["chat"],
          priority: 90,
          connection: null,
          state: "pending",
          action: { kind: "review", serverId: "srv-1" },
        },
      ],
      connected: false,
      awaitingReview: true,
    },
  }),
  item({
    kind: "integration",
    id: "github-delivery:github",
    data: {
      id: "github-delivery:github",
      pluginId: "github-delivery",
      integrationId: "github",
      label: "GitHub",
      description: "Issues, pull requests, checks and the action approval queue.",
      category: "developer",
      actionCount: 6,
      eventCount: 12,
      authKinds: ["app", "personal-access-token"],
    },
  }),
]

const meta = {
  title: "Discover/DiscoverInspector",
  component: DiscoverInspector,
  args: { category: "characters", itemId: null, items, onClose: fn() },
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <div className="flex h-[560px] w-80 flex-col border-l">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof DiscoverInspector>

export default meta
type Story = StoryObj<typeof meta>

export const Overview: Story = {}

export const CharacterSelected: Story = { args: { itemId: "c1" } }

export const SkillSelected: Story = { args: { category: "skills", itemId: "s1" } }

export const DocsProviderSelected: Story = {
  args: { category: "docsProviders", itemId: "lark" },
}

export const ExternalServiceSelected: Story = {
  args: { category: "externalServices", itemId: "figma-external-service:figma" },
}

export const IntegrationSelected: Story = {
  args: { category: "integrations", itemId: "github-delivery:github" },
}

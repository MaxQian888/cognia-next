import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { fn } from "storybook/test"

import { DiscoverItemCard } from "./discover-item-card"
import type { DiscoverItem } from "@/hooks/discover/use-discover-query"

// `useItemMeta` only reads a handful of fields per kind, so minimal cast
// fixtures are enough to exercise each card variant.
const item = (raw: { kind: string; id: string; data: Record<string, unknown> }): DiscoverItem =>
  raw as unknown as DiscoverItem

const meta = {
  title: "Discover/DiscoverItemCard",
  component: DiscoverItemCard,
  args: { selected: false, onSelect: fn() },
  parameters: { layout: "padded" },
} satisfies Meta<typeof DiscoverItemCard>

export default meta
type Story = StoryObj<typeof meta>

export const Character: Story = {
  args: {
    item: item({
      kind: "character",
      id: "c1",
      data: {
        name: "Ada",
        description: "A meticulous senior engineer persona.",
        isBuiltIn: true,
        avatarColor: "#7c3aed",
        avatarEmoji: "🧠",
      },
    }),
  },
}

export const Skill: Story = {
  args: {
    item: item({
      kind: "skill",
      id: "s1",
      data: { name: "PDF reading", description: "Extract text from PDFs.", status: "enabled" },
    }),
  },
}

export const DisabledSkill: Story = {
  args: {
    item: item({
      kind: "skill",
      id: "s2",
      data: { name: "Legacy importer", description: "Old import flow.", status: "disabled" },
    }),
  },
}

export const McpServer: Story = {
  args: {
    item: item({
      kind: "mcpServer",
      id: "m1",
      data: { name: "context7", transport: "stdio", enabled: true },
    }),
  },
}

export const Selected: Story = {
  args: {
    selected: true,
    item: item({
      kind: "plugin",
      id: "p1",
      data: {
        name: "GitHub Delivery",
        id: "github-delivery",
        version: "1.2.0",
        source: "builtin",
        enabled: true,
      },
    }),
  },
}

export const DocsProvider: Story = {
  args: {
    item: item({
      kind: "docsProvider",
      id: "lark",
      data: {
        id: "lark",
        mentionPrefix: "lark:",
        kinds: ["doc", "wiki", "sheet"],
        hosts: ["tauri"],
      },
    }),
  },
}

export const ExternalServiceConnected: Story = {
  args: {
    item: item({
      kind: "externalService",
      id: "figma-external-service:figma",
      data: {
        key: "figma-external-service:figma",
        pluginId: "figma-external-service",
        serviceId: "figma",
        label: "Figma",
        description: "Design context, canvas editing, Code Connect and assets.",
        icon: "🎨",
        skillIds: ["figma-use"],
        providers: [],
        connected: true,
        awaitingReview: false,
      },
    }),
  },
}

export const ExternalServiceAwaitingReview: Story = {
  args: {
    item: item({
      kind: "externalService",
      id: "figma-external-service:figma",
      data: {
        key: "figma-external-service:figma",
        pluginId: "figma-external-service",
        serviceId: "figma",
        label: "Figma",
        description: "Design context, canvas editing, Code Connect and assets.",
        icon: "🎨",
        skillIds: ["figma-use"],
        providers: [],
        connected: false,
        awaitingReview: true,
      },
    }),
  },
}

export const Integration: Story = {
  args: {
    item: item({
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
        authKinds: ["app"],
      },
    }),
  },
}

import type { Meta, StoryObj } from "@storybook/nextjs-vite"

import { ServiceCard } from "./service-card"
import type { ServiceProviderView, ServiceView } from "@/lib/external-services/service-view"

const meta = {
  title: "Settings/ExternalServices/ServiceCard",
  component: ServiceCard,
  parameters: { layout: "centered" },
  decorators: [
    (Story) => (
      <div className="w-[520px]">
        <Story />
      </div>
    ),
  ],
  args: { onToggleProvider: () => {} },
} satisfies Meta<typeof ServiceCard>

export default meta
type Story = StoryObj<typeof meta>

function provider(overrides: Partial<ServiceProviderView> = {}): ServiceProviderView {
  return {
    providerId: "desktop",
    kind: "mcp",
    availability: "supported",
    surfaces: ["chat", "workflow"],
    priority: 90,
    connection: null,
    state: "not-connected",
    action: { kind: "none" },
    ...overrides,
  }
}

const connection = {
  enabledSurfaces: ["chat", "workflow"],
} as unknown as ServiceProviderView["connection"]

function figma(overrides: Partial<ServiceView> = {}): ServiceView {
  return {
    key: "figma-external-service:figma",
    pluginId: "figma-external-service",
    serviceId: "figma",
    label: "Figma",
    description:
      "Design context, canvas editing, Code Connect, assets, resources, and prompts through interchangeable reviewed MCP providers.",
    icon: "🎨",
    skillIds: ["figma-use", "figma-design-to-code", "figma-code-connect"],
    providers: [
      provider({ providerId: "remote", priority: 100, availability: "vendor-pending" }),
      provider({ providerId: "desktop" }),
    ],
    connected: false,
    awaitingReview: false,
    ...overrides,
  }
}

/**
 * The state a freshly installed bundled service actually rests in: one
 * provider blocked upstream, one holding an unreviewed MCP server. This is
 * what used to render as two flat rows reading "pending" whose only control
 * was Pause.
 */
export const AwaitingReview: Story = {
  args: {
    service: figma({
      awaitingReview: true,
      providers: [
        provider({
          providerId: "remote",
          priority: 100,
          availability: "vendor-pending",
          action: { kind: "blocked-upstream" },
        }),
        provider({
          providerId: "desktop",
          state: "pending",
          connection,
          action: { kind: "review", serverId: "srv-figma-desktop" },
        }),
      ],
    }),
  },
}

export const Connected: Story = {
  args: {
    service: figma({
      connected: true,
      providers: [
        provider({
          providerId: "remote",
          priority: 100,
          availability: "vendor-pending",
          action: { kind: "blocked-upstream" },
        }),
        provider({
          providerId: "desktop",
          state: "connected",
          connection,
          action: { kind: "manage", serverId: "srv-figma-desktop" },
        }),
      ],
    }),
  },
}

export const Paused: Story = {
  args: {
    service: figma({
      providers: [
        provider({
          providerId: "desktop",
          state: "suspended",
          connection,
          action: { kind: "resume" },
        }),
      ],
    }),
  },
}

/** A service with a single ordinary provider and nothing provisioned yet. */
export const NothingProvisioned: Story = {
  args: {
    service: figma({
      label: "Acme Admin",
      icon: undefined,
      description: "An OpenAPI-backed service with no accounts connected.",
      skillIds: [],
      providers: [provider({ providerId: "api", kind: "openapi" })],
    }),
  },
}

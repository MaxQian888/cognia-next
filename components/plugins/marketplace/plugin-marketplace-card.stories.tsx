import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { fn } from "storybook/test"

import { PluginMarketplaceCard } from "./plugin-marketplace-card"
import type { PluginMarketplaceEntry } from "@/hooks/plugins/use-plugin-marketplace"

// Marketplace page card. This is the browse-grid tile on Plugins → Discover.
// Stories cover the install-state matrix (available / installing / installed /
// built-in) plus the danger-permission warning, and a "Page" story that lays
// the cards out in the same responsive grid the marketplace pane uses.

type Entry = PluginMarketplaceEntry & {
  capabilities?: string[]
  permissions?: string[]
}

const makeEntry = (over: Partial<Entry> = {}): Entry => ({
  id: "com.acme.web-tools",
  name: "Web Tools",
  version: "2.1.0",
  description:
    "Fetch pages, extract readable content, and run lightweight scrapes straight from chat.",
  author: "Acme Labs",
  rating: 4.7,
  downloads: 18234,
  signed: true,
  type: "plugin",
  source: "marketplace",
  capabilities: ["tools", "mcp", "commands"],
  permissions: ["network:fetch"],
  ...over,
})

const callbacks = {
  onView: fn(),
  onInstall: fn(),
  onUninstall: fn(),
}

const meta = {
  title: "Plugins/Marketplace/PluginMarketplaceCard",
  component: PluginMarketplaceCard,
  args: { entry: makeEntry(), installed: false, installing: false, ...callbacks },
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <div className="w-[340px] max-w-full">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof PluginMarketplaceCard>

export default meta
type Story = StoryObj<typeof meta>

export const Available: Story = {}

export const Installing: Story = { args: { installing: true } }

export const Installed: Story = { args: { installed: true } }

export const Dangerous: Story = {
  args: {
    entry: makeEntry({
      id: "com.acme.shell-runner",
      name: "Shell Runner",
      description: "Runs shell commands and spawns processes on the host.",
      permissions: ["shell:execute", "process:spawn"],
      capabilities: ["tools"],
      signed: false,
    }),
  },
}

export const Unsigned: Story = {
  args: { entry: makeEntry({ signed: false }) },
}

export const Builtin: Story = {
  args: {
    entry: makeEntry({
      id: "com.cognia.screenshot",
      name: "Screenshot",
      author: "Cognia",
      source: "builtin",
      capabilities: ["tools"],
      permissions: ["automation:screenshot"],
    }),
  },
}

export const Minimal: Story = {
  args: {
    entry: makeEntry({
      id: "com.acme.tiny",
      name: "Tiny Plugin",
      description: undefined,
      author: undefined,
      rating: 0,
      downloads: 0,
      capabilities: [],
      permissions: [],
    }),
  },
}

// A realistic Discover page: a grid of cards in mixed install/danger states,
// matching the responsive columns the marketplace pane renders.
export const Page: Story = {
  render: () => {
    const entries: Entry[] = [
      makeEntry(),
      makeEntry({
        id: "com.acme.clipboard",
        name: "Clipboard History",
        description: "Keep a searchable history of everything you copy.",
        rating: 4.9,
        downloads: 92011,
        capabilities: ["tools", "commands"],
        permissions: ["clipboard:read", "clipboard:write"],
      }),
      makeEntry({
        id: "com.acme.shell-runner",
        name: "Shell Runner",
        description: "Runs shell commands and spawns processes on the host.",
        rating: 3.8,
        downloads: 540,
        signed: false,
        capabilities: ["tools"],
        permissions: ["shell:execute"],
      }),
      makeEntry({
        id: "com.cognia.screenshot",
        name: "Screenshot",
        author: "Cognia",
        source: "builtin",
        capabilities: ["tools"],
        permissions: ["automation:screenshot"],
      }),
    ]
    return (
      <div className="grid w-[720px] max-w-full grid-cols-1 gap-3 sm:grid-cols-2">
        {entries.map((entry) => (
          <PluginMarketplaceCard
            key={entry.id}
            entry={entry}
            installed={entry.id === "com.acme.clipboard"}
            installing={false}
            {...callbacks}
          />
        ))}
      </div>
    )
  },
}

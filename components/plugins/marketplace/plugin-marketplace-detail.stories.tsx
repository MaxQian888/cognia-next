import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { fn } from "storybook/test"

import { PluginMarketplaceDetail } from "./plugin-marketplace-detail"
import type { PluginMarketplaceEntry } from "@/hooks/plugins/use-plugin-marketplace"
import type { PluginPermission } from "@/types/plugin"

// Detail sheet shown when a marketplace card is clicked. Surfaces metadata,
// the declared/optional permission preview (dangerous perms flagged), the
// dependency list, an optional README, and the install / uninstall CTA.
// Stories cover the install-state matrix (available / installing / installed /
// built-in) plus a dangerous-permission variant and a minimal entry. The sheet
// is portal-mounted, so it always renders `open` here.

type DetailEntry = PluginMarketplaceEntry & {
  capabilities?: string[]
  permissions?: PluginPermission[]
  optionalPermissions?: PluginPermission[]
  dependencies?: Record<string, string>
  homepage?: string
  repository?: string
  readme?: string
  license?: string
}

const makeEntry = (over: Partial<DetailEntry> = {}): DetailEntry => ({
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
  license: "MIT",
  homepage: "https://example.com/web-tools",
  repository: "https://github.com/acme/web-tools",
  capabilities: ["tools", "mcp", "commands"],
  permissions: ["network:fetch"] as PluginPermission[],
  optionalPermissions: ["clipboard:read"] as PluginPermission[],
  dependencies: { "@cognia/core": "^1.0.0" },
  readme:
    "## Web Tools\n\nFetch and parse pages directly from chat.\n\n- Readable extraction\n- Lightweight scrapes",
  ...over,
})

const callbacks = {
  onClose: fn(),
  onInstall: fn(),
  onUninstall: fn(),
}

const meta = {
  title: "Plugins/Marketplace/PluginMarketplaceDetail",
  component: PluginMarketplaceDetail,
  args: { open: true, entry: makeEntry(), installed: false, installing: false, ...callbacks },
  parameters: { layout: "padded" },
} satisfies Meta<typeof PluginMarketplaceDetail>

export default meta
type Story = StoryObj<typeof meta>

export const Available: Story = {}

export const Installing: Story = { args: { installing: true } }

export const Installed: Story = { args: { installed: true } }

// Dangerous declared permissions render the warning triangle in the preview.
export const DangerousPermissions: Story = {
  args: {
    entry: makeEntry({
      id: "com.acme.shell-runner",
      name: "Shell Runner",
      description: "Runs shell commands and spawns processes on the host.",
      author: "Acme Labs",
      signed: false,
      permissions: ["shell:execute", "process:spawn"] as PluginPermission[],
      optionalPermissions: ["filesystem:write"] as PluginPermission[],
      capabilities: ["tools"],
      readme: undefined,
    }),
  },
}

// Built-in entries swap the install CTA for a "Built-in" source badge.
export const Builtin: Story = {
  args: {
    entry: makeEntry({
      id: "com.cognia.screenshot",
      name: "Screenshot",
      author: "Cognia",
      source: "builtin",
      capabilities: ["tools"],
      permissions: ["automation:screenshot"] as PluginPermission[],
      optionalPermissions: [],
      dependencies: {},
      homepage: undefined,
      repository: undefined,
      readme: undefined,
    }),
    installed: true,
  },
}

// Sparse registry response: only the required fields, no README / homepage /
// permissions / dependencies.
export const Minimal: Story = {
  args: {
    entry: makeEntry({
      id: "com.acme.tiny",
      name: "Tiny Plugin",
      description: undefined,
      author: undefined,
      license: undefined,
      homepage: undefined,
      repository: undefined,
      capabilities: [],
      permissions: [],
      optionalPermissions: [],
      dependencies: {},
      readme: undefined,
    }),
  },
}

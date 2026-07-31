import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { fn } from "storybook/test"

import { PluginCard } from "./plugin-card"
import type { PluginRow } from "@/lib/db/plugin-types"

// Installed-tab plugin card tile. This is the rich card the InstalledTab paints
// in grid view — version, capability chips, permission count, signature status,
// status pill, and the per-row actions menu. The stories exercise the full
// state matrix the real grid renders (enabled / disabled / errored /
// update-available / loading / signed / selected) plus a "Grid" story that lays
// the cards out the way the InstalledTab grid does.

const makeRow = (over: Partial<PluginRow> = {}): PluginRow => ({
  id: "com.acme.clipboard",
  name: "Clipboard History",
  version: "1.4.2",
  status: "enabled",
  source: "marketplace",
  type: "frontend",
  enabled: true,
  capabilities: ["tools", "commands", "modes", "themes"],
  path: "/plugins/clipboard",
  manifest: {
    id: "com.acme.clipboard",
    icon: "📋",
    permissions: ["clipboard:read", "clipboard:write"],
    signature: { verified: true },
  },
  createdAt: 0,
  updatedAt: 0,
  ...over,
})

const handlers = {
  onToggleSelect: fn(),
  onOpen: fn(),
  onConfigure: fn(),
  onToggleEnabled: fn(),
  onUninstall: fn(),
  onReviewPermissions: fn(),
  onRollback: fn(),
}

const meta = {
  title: "Plugins/PluginCard",
  component: PluginCard,
  args: { plugin: makeRow(), selected: false, ...handlers },
  parameters: { layout: "centered" },
  // Fixed width so the chip row, permission count, and status pill wrap the way
  // they do inside the InstalledTab grid columns.
  decorators: [
    (Story) => (
      <div className="w-[340px] max-w-full">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof PluginCard>

export default meta
type Story = StoryObj<typeof meta>

export const Enabled: Story = {}

export const Selected: Story = { args: { selected: true } }

export const Disabled: Story = {
  args: { plugin: makeRow({ enabled: false, status: "disabled" }) },
}

export const Loading: Story = {
  args: { plugin: makeRow({ status: "enabling" }) },
}

export const UpdateAvailable: Story = {
  args: {
    plugin: makeRow({
      manifest: {
        id: "com.acme.clipboard",
        icon: "📋",
        permissions: ["clipboard:read"],
        signature: { verified: true },
        updateAvailable: true,
      },
    }),
  },
}

export const Signed: Story = {
  args: {
    plugin: makeRow({
      manifest: {
        id: "com.acme.clipboard",
        icon: "📋",
        permissions: ["clipboard:read", "clipboard:write"],
        signature: { verified: true },
      },
    }),
  },
}

export const Unsigned: Story = {
  args: {
    plugin: makeRow({
      manifest: {
        id: "com.acme.clipboard",
        icon: "📋",
        permissions: ["clipboard:read"],
        signature: { failed: true },
      },
    }),
  },
}

// Dangerous permissions raise the warning triangle next to the permission count.
export const DangerousPermissions: Story = {
  args: {
    plugin: makeRow({
      id: "com.acme.shell-runner",
      name: "Shell Runner",
      capabilities: ["tools"],
      manifest: {
        id: "com.acme.shell-runner",
        permissions: ["shell:execute", "process:spawn", "filesystem:write"],
        signature: { verified: true },
      },
    }),
  },
}

export const Errored: Story = {
  args: {
    plugin: makeRow({
      id: "com.acme.ocr",
      name: "OCR Engine",
      status: "error",
      error: "Failed to load runtime: python interpreter not found",
      capabilities: ["tools", "modes"],
      manifest: {
        id: "com.acme.ocr",
        permissions: ["python:execute"],
      },
    }),
  },
}

// Card with no actionable rollback handler — the Rollback menu item is hidden.
export const NoRollback: Story = {
  args: { onRollback: undefined },
}

// A realistic InstalledTab grid: a mix of states laid out the way the grid
// renders them, including the selected, errored, and update-available cards.
export const Grid: Story = {
  render: () => {
    const rows: PluginRow[] = [
      makeRow({ id: "com.acme.clipboard", name: "Clipboard History" }),
      makeRow({
        id: "com.acme.web-tools",
        name: "Web Tools",
        capabilities: ["tools", "mcp"],
        manifest: {
          id: "com.acme.web-tools",
          icon: "🌐",
          permissions: ["network:fetch", "filesystem:write"],
          signature: { verified: true },
          updateAvailable: true,
        },
      }),
      makeRow({
        id: "com.acme.screenshot",
        name: "Screenshot",
        enabled: false,
        status: "disabled",
        capabilities: ["tools"],
        manifest: {
          id: "com.acme.screenshot",
          icon: "📸",
          permissions: ["screen:capture"],
        },
      }),
      makeRow({
        id: "com.acme.ocr",
        name: "OCR Engine",
        status: "error",
        error: "Native module failed to compile",
        capabilities: ["tools", "modes"],
        manifest: { id: "com.acme.ocr", permissions: ["filesystem:read"] },
      }),
    ]
    return (
      <div className="grid w-[720px] max-w-full grid-cols-1 gap-3 sm:grid-cols-2">
        {rows.map((row) => (
          <PluginCard
            key={row.id}
            plugin={row}
            selected={row.id === "com.acme.clipboard"}
            {...handlers}
          />
        ))}
      </div>
    )
  },
}

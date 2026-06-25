import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { fn } from "storybook/test"

import { PluginLibraryRow } from "./plugin-library-row"
import type { PluginRow } from "@/lib/db/plugin-types"

// Library page list row. This is the one-row-per-plugin surface that fills the
// Plugins → Library pane in list view. The stories exercise the full state
// matrix the real list paints (enabled / disabled / errored / updatable /
// loading / signed) plus a "Page" story that stacks several rows behind the
// `@container/plugin-list` query the row's capability/permission columns read.

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
  title: "Plugins/Library/PluginLibraryRow",
  component: PluginLibraryRow,
  args: { plugin: makeRow(), selected: false, active: false, ...handlers },
  parameters: { layout: "padded" },
  // The row hides its capability/permission columns until the `@container`
  // is wide enough — wrap every story in the same named container the Library
  // list mounts so those columns actually render in the preview.
  decorators: [
    (Story) => (
      <div className="@container/plugin-list w-[760px] max-w-full divide-y rounded-md border">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof PluginLibraryRow>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

export const Active: Story = { args: { active: true } }

export const Selected: Story = { args: { selected: true } }

export const Disabled: Story = {
  args: { plugin: makeRow({ enabled: false, status: "disabled" }) },
}

export const UpdateAvailable: Story = {
  args: {
    plugin: makeRow({
      version: "1.4.2",
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

export const Loading: Story = {
  args: { plugin: makeRow({ status: "enabling" }) },
}

export const Errored: Story = {
  args: {
    plugin: makeRow({
      status: "error",
      error: "Failed to load runtime: python interpreter not found",
      manifest: { id: "com.acme.clipboard", permissions: ["python:execute"] },
    }),
  },
}

export const Unsigned: Story = {
  args: {
    plugin: makeRow({
      manifest: {
        id: "com.acme.clipboard",
        permissions: ["clipboard:read"],
        signature: { failed: true },
      },
    }),
  },
}

// A realistic Library page: a mix of states stacked the way the list renders
// them, including the active (detail-open) row and an errored one.
export const Page: Story = {
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
        manifest: { id: "com.acme.screenshot", icon: "📸", permissions: ["screen:capture"] },
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
      <div role="list" data-testid="plugin-library-list">
        {rows.map((row) => (
          <PluginLibraryRow
            key={row.id}
            plugin={row}
            selected={false}
            active={row.id === "com.acme.web-tools"}
            {...handlers}
          />
        ))}
      </div>
    )
  },
}

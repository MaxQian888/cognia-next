import type { Decorator, Meta, StoryObj } from "@storybook/nextjs-vite"
import { fn } from "storybook/test"

import { PluginBackupPanel, __resetPluginBackupClientForTests } from "./plugin-backup-panel"
import type { PluginBackup } from "@/lib/plugin/lifecycle/backup"

// Per-plugin backup panel from a plugin's detail surface. The panel reads its
// snapshot list through a module-level client seam (`getPluginBackupManager`
// in prod), which the unit test swaps via `__resetPluginBackupClientForTests`.
// These stories install a static in-memory client through that same seam so the
// empty and populated states render without the native bridge. In this plain
// browser `isTauri()` is false, so the desktop-only hint shows and the mutating
// actions render disabled — that's the real web-build appearance.

const makeBackup = (over: Partial<PluginBackup> = {}): PluginBackup => ({
  id: "snap-9f2c1a7e3b",
  pluginId: "com.acme.clipboard",
  version: "1.4.2",
  createdAt: new Date("2026-05-03T12:00:00.000Z"),
  reason: "manual",
  size: 48128,
  path: "/plugins/clipboard/backups/snap-9f2c1a7e3b",
  ...over,
})

// Decorator factory: installs a static backup client before the panel mounts so
// `getBackups` returns the story's fixtures.
const withBackups = (backups: PluginBackup[]): Decorator =>
  function WithBackups(Story) {
    __resetPluginBackupClientForTests({
      createBackup: fn(async () => ({ success: true, backup: backups[0] })),
      restore: fn(async () => undefined),
      getBackups: () => backups,
      deleteBackup: fn(async () => true),
    })
    return (
      <div className="w-[420px] max-w-full">
        <Story />
      </div>
    )
  }

const meta = {
  title: "Plugins/PluginBackupPanel",
  component: PluginBackupPanel,
  args: { pluginId: "com.acme.clipboard" },
  parameters: { layout: "padded" },
} satisfies Meta<typeof PluginBackupPanel>

export default meta
type Story = StoryObj<typeof meta>

export const Empty: Story = {
  decorators: [withBackups([])],
}

export const WithBackups: Story = {
  decorators: [
    withBackups([
      makeBackup(),
      makeBackup({
        id: "snap-1a4d8e0f22",
        version: "1.4.1",
        createdAt: new Date("2026-04-28T09:15:00.000Z"),
        reason: "pre-update",
        size: 51200,
      }),
      makeBackup({
        id: "snap-7c0b3aa915",
        version: "1.4.0",
        createdAt: new Date("2026-04-10T18:42:00.000Z"),
        reason: "scheduled",
        size: 0,
      }),
    ]),
  ],
}

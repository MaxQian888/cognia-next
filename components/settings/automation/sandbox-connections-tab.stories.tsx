import type { Meta, StoryObj } from "@storybook/nextjs"

import { SandboxConnectionsTab } from "./sandbox-connections-tab"
import { clearDb, seedDb } from "@/lib/storybook/seed-db"
import { createSandboxConnectionRow } from "@/lib/db/sandbox-connections"

// Dexie-reading via `useSandboxConnections` (`sandboxConnections` table). The
// lifecycle buttons need the Tauri shell (Docker orchestration is Rust), so
// they render disabled in the Storybook browser. Default is an empty registry;
// the populated story seeds a couple of rows with different health states.
const meta = {
  title: "Settings/Automation/SandboxConnectionsTab",
  component: SandboxConnectionsTab,
  parameters: { layout: "padded" },
  beforeEach: async () => {
    await clearDb()
  },
  decorators: [
    (Story) => (
      <div className="w-[640px] max-w-full">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof SandboxConnectionsTab>

export default meta
type Story = StoryObj<typeof meta>

// Empty registry → empty note + "Add connection" button.
export const Default: Story = {}

// Two registered sandboxes with contrasting health badges.
export const Populated: Story = {
  beforeEach: async () => {
    await seedDb(async (db) => {
      const now = Date.now()
      await db.sandboxConnections.bulkPut([
        {
          ...createSandboxConnectionRow({
            id: "sbx-1",
            name: "home-docker",
            driver: "computer-server",
            config: {
              provider: "docker",
              image: "ghcr.io/trycua/cua-xfce:latest",
              host: "127.0.0.1",
              port: 8100,
            },
            now: now - 86_400_000,
          }),
          state: "running",
          lastHealthStatus: "ok",
          lastHealthCheckAt: now - 30_000,
          updatedAt: now - 30_000,
        },
        {
          ...createSandboxConnectionRow({
            id: "sbx-2",
            name: "lab-box",
            driver: "computer-server",
            config: {
              provider: "docker",
              image: "ghcr.io/trycua/cua-xfce:latest",
              host: "10.0.0.5",
              port: 0,
            },
            now: now - 172_800_000,
          }),
          state: "error",
          lastHealthStatus: "unreachable",
          lastHealthError: "connection refused",
          updatedAt: now - 600_000,
        },
      ])
    })
  },
}

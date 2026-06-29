import type { Meta, StoryObj } from "@storybook/nextjs"

import { ImportPreview } from "./import-preview"
import type { BackupPackageV3 } from "@/lib/data/types"

// Pure prop — renders the manifest header + per-table row counts from a v3
// backup payload. Build a representative package fixture.
const pkg = (payload: Partial<BackupPackageV3["payload"]>): BackupPackageV3 =>
  ({
    manifest: {
      backend: "web-dexie",
      appVersion: "1.4.0",
      exportedAt: new Date("2026-06-20T10:30:00Z").toISOString(),
      schemaVersion: 92,
      integrity: { checksum: "ab12cd34ef56ab12cd34ef56" },
      traceId: "trace-9f8e7d6c",
    },
    payload,
  }) as unknown as BackupPackageV3

const meta = {
  title: "Data/ImportPreview",
  component: ImportPreview,
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <div className="w-[28rem]">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ImportPreview>

export default meta
type Story = StoryObj<typeof meta>

export const Populated: Story = {
  args: {
    pkg: pkg({
      settings: { id: "singleton" },
      characters: [{ id: "c1" }, { id: "c2" }],
      skills: [{ id: "s1" }],
      sessions: [{ id: "ses1" }, { id: "ses2" }, { id: "ses3" }],
      messages: Array.from({ length: 42 }, (_, i) => ({ id: `m${i}` })),
      localStorageSnapshots: { theme: "dark", locale: "en" },
    } as unknown as BackupPackageV3["payload"]),
  },
}

export const NearlyEmpty: Story = {
  args: {
    pkg: pkg({ settings: { id: "singleton" } } as unknown as BackupPackageV3["payload"]),
  },
}

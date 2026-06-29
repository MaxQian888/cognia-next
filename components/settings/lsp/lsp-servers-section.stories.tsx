import type { Meta, StoryObj } from "@storybook/nextjs"

import { LspServersSection } from "./lsp-servers-section"
import { resetStores, seedStore } from "@/lib/storybook/seed-stores"
import { useSettingsStore } from "@/stores/settings"
import { useLspStatusStore } from "@/lib/lsp/lsp-status-store"
import { makeAgentAppSettings } from "@/lib/storybook/fixtures/settings-agent"

// `LspServersSection` edits `AppSettings.lsp.servers`: a read-only table of the
// builtin defaults (typescript / pyright / rust-analyzer / gopls) plus a
// user-authored "Your servers" table, with an effective-merge preview and a
// logs viewer. Binary detection (`useLspStatusStore`) is inert on the web
// preview, so no status badges appear.
const customServer = {
  id: "lsp_lua",
  name: "lua-language-server",
  languages: ["lua"],
  command: "lua-language-server",
  transport: "stdio",
  enabled: true,
}

const meta = {
  title: "Settings/Lsp/LspServersSection",
  component: LspServersSection,
  parameters: { layout: "padded" },
  beforeEach: () => {
    resetStores(useSettingsStore, useLspStatusStore)
    seedStore(useSettingsStore, { settings: makeAgentAppSettings() })
  },
  decorators: [
    (Story) => (
      <div className="max-w-4xl">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof LspServersSection>

export default meta
type Story = StoryObj<typeof meta>

// Builtin defaults only — the "Your servers" group shows its empty state.
export const Default: Story = {}

// One user-authored server in the custom table.
export const WithCustomServer: Story = {
  beforeEach: () => {
    resetStores(useSettingsStore, useLspStatusStore)
    seedStore(useSettingsStore, {
      settings: makeAgentAppSettings({ lsp: { servers: [customServer] } }),
    })
  },
}

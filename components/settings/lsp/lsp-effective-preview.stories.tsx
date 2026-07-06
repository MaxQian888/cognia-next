import type { Meta, StoryObj } from "@storybook/nextjs"

import { LspEffectivePreview } from "./lsp-effective-preview"
import { resetStore } from "@/lib/storybook/seed-stores"
import { useProjectStore } from "@/stores/project/project-store"
import type { LspServerConfig } from "@/types/lsp/config"

// `LspEffectivePreview` shows the EFFECTIVE server list the resolver produces
// after layering builtin defaults ← user settings ← the active project's
// `.cognia/lsp.json`. On the web preview the project layer reader returns null,
// so the preview reflects builtin + the passed `userServers`.
const userServer: LspServerConfig = {
  id: "rust-analyzer",
  name: "rust-analyzer (overridden)",
  languages: ["rust"],
  command: "rust-analyzer",
  transport: "stdio",
  enabled: true,
  settings: { "rust-analyzer": { cargo: { features: "all" } } },
}

const meta = {
  title: "Settings/Lsp/LspEffectivePreview",
  component: LspEffectivePreview,
  parameters: { layout: "padded" },
  args: { userServers: [] },
  beforeEach: () => {
    resetStore(useProjectStore)
  },
  decorators: [
    (Story) => (
      <div className="max-w-2xl">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof LspEffectivePreview>

export default meta
type Story = StoryObj<typeof meta>

// No user layer — the resolved list is the builtin defaults.
export const BuiltinsOnly: Story = {}

// A user entry that overrides a builtin (provenance badge on the row).
export const WithUserOverride: Story = {
  args: { userServers: [userServer] },
}

import type { Meta, StoryObj } from "@storybook/nextjs"

import { PluginImportDialog } from "./plugin-import-dialog"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { usePluginsStore } from "@/stores/plugins"

// Import confirmation gate, driven by `usePluginsStore.importStaging`. Shows the
// staged manifest drafts + any parse errors before the user confirms a local
// install. Seed `importStaging` to open it.

const meta = {
  title: "Plugins/Dialogs/PluginImportDialog",
  component: PluginImportDialog,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof PluginImportDialog>

export default meta
type Story = StoryObj<typeof meta>

// Two valid drafts staged for import.
export const StagedDrafts: Story = {
  beforeEach: () => {
    seedStore(usePluginsStore, {
      importStaging: {
        sourceLabel: "plugins.zip",
        parseErrors: [],
        drafts: [
          {
            id: "com.acme.web-tools",
            name: "Web Tools",
            version: "2.1.0",
            sourceLabel: "plugins.zip/web-tools",
            manifest: { id: "com.acme.web-tools", type: "frontend", capabilities: ["tools"] },
          },
          {
            id: "com.acme.ocr",
            name: "OCR Engine",
            version: "0.9.1",
            sourceLabel: "plugins.zip/ocr",
            manifest: { id: "com.acme.ocr", type: "python" },
          },
        ],
      },
    })
    return () => resetStore(usePluginsStore)
  },
}

// One valid draft plus a manifest that failed to parse → warning list.
export const WithParseErrors: Story = {
  beforeEach: () => {
    seedStore(usePluginsStore, {
      importStaging: {
        sourceLabel: "mixed-bundle.zip",
        parseErrors: [{ name: "broken-plugin", error: "Missing required field: version" }],
        drafts: [
          {
            id: "com.acme.web-tools",
            name: "Web Tools",
            version: "2.1.0",
            sourceLabel: "mixed-bundle.zip/web-tools",
            manifest: { id: "com.acme.web-tools", type: "frontend" },
          },
        ],
      },
    })
    return () => resetStore(usePluginsStore)
  },
}

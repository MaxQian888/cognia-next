import type { Meta, StoryObj } from "@storybook/nextjs"

import { FileViewerDialog } from "./file-viewer-dialog"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { useFileViewerStore } from "@/stores/terminal/file-viewer-store"

// Read-only file viewer for terminal path links. Driven by `useFileViewerStore`:
// opening with a path loads the file (Tauri `readTextFile`) into a read-only
// Monaco editor. Outside Tauri the read rejects, so the dialog shows its loading
// then error chrome — which is what these stories exercise.
const meta = {
  title: "Terminal/FileViewerDialog",
  component: FileViewerDialog,
  parameters: { layout: "fullscreen" },
  beforeEach: () => {
    resetStore(useFileViewerStore)
  },
} satisfies Meta<typeof FileViewerDialog>

export default meta
type Story = StoryObj<typeof meta>

// Closed store → nothing rendered.
export const Closed: Story = {}

export const Open: Story = {
  beforeEach: () => {
    resetStore(useFileViewerStore)
    seedStore(useFileViewerStore, {
      open: true,
      path: "D:/Project/cognia-next/src/main.ts",
    })
  },
}

export const OpenAtLine: Story = {
  beforeEach: () => {
    resetStore(useFileViewerStore)
    seedStore(useFileViewerStore, {
      open: true,
      path: "D:/Project/cognia-next/lib/utils.ts",
      line: 42,
      column: 8,
    })
  },
}

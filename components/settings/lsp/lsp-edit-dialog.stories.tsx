import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { LspEditDialog } from "./lsp-edit-dialog"
import type { LspServerConfig } from "@/types/lsp/config"

// `LspEditDialog` is the prop-driven add / edit form for a Language Server
// entry. In add mode (`initial` omitted) it generates a fresh id on submit; in
// edit / override mode the supplied entry prefills the form and pins its id.
const existing: LspServerConfig = {
  id: "typescript",
  name: "TypeScript",
  languages: ["typescript", "typescriptreact"],
  extensions: [".ts", ".tsx"],
  command: "typescript-language-server",
  args: ["--stdio"],
  transport: "stdio",
  enabled: true,
  settings: { typescript: { tsserver: { maxTsServerMemory: 4096 } } },
}

const meta = {
  title: "Settings/Lsp/LspEditDialog",
  component: LspEditDialog,
  parameters: { layout: "centered" },
  args: {
    open: true,
    onOpenChange: fn(),
    onSubmit: fn(),
    existingIds: ["typescript", "pyright"],
  },
} satisfies Meta<typeof LspEditDialog>

export default meta
type Story = StoryObj<typeof meta>

// Add mode — a blank form with a generated id on submit.
export const Add: Story = {}

// Edit mode — prefilled from an existing (here builtin-override) entry.
export const Edit: Story = {
  args: { initial: existing },
}

// Closed — nothing rendered.
export const Closed: Story = {
  args: { open: false },
}

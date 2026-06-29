import type { Meta, StoryObj } from "@storybook/nextjs"

import { DomainImportDialog } from "./domain-import-dialog"
import { Button } from "@/components/ui/button"

// Single-domain importer (e.g. just characters, or just skills). Manages its
// own open state, so it needs a trigger; clicking opens the merge-strategy +
// file picker flow scoped to `domain`.
const meta = {
  title: "Data/DomainImportDialog",
  component: DomainImportDialog,
  args: {
    domain: "characters",
    labelKey: "characters",
    trigger: <Button variant="outline">Import characters</Button>,
  },
  parameters: { layout: "padded" },
} satisfies Meta<typeof DomainImportDialog>

export default meta
type Story = StoryObj<typeof meta>

export const Characters: Story = {}

export const Skills: Story = {
  args: {
    domain: "skills",
    labelKey: "skills",
    trigger: <Button variant="outline">Import skills</Button>,
  },
}

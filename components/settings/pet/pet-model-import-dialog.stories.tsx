import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { PetModelImportDialog } from "./pet-model-import-dialog"
import { makeDiscoveredModels } from "@/lib/storybook/fixtures/pet"

// Props-only selection dialog for a multi-model bundle. The caller discovers +
// groups the models; this dialog lists them (valid rows selectable, invalid
// rows disabled with their error) and reports the chosen ids. `onOpenChange` /
// `onImported` are spies; the actual import helper is module-level and not
// exercised in the static stories.
const meta = {
  title: "Settings/Pet/PetModelImportDialog",
  component: PetModelImportDialog,
  parameters: { layout: "fullscreen" },
  args: {
    models: makeDiscoveredModels(),
    open: true,
    onOpenChange: fn(),
    onImported: fn(),
  },
} satisfies Meta<typeof PetModelImportDialog>

export default meta
type Story = StoryObj<typeof meta>

// Two valid models + one invalid group (shown disabled with its reason).
export const Default: Story = {}

// Only valid models — "Select all" enables the whole list.
export const AllValid: Story = {
  args: { models: makeDiscoveredModels().filter((m) => m.valid) },
}

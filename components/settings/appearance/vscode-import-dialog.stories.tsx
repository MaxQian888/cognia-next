import type { Meta, StoryObj } from "@storybook/nextjs"
import { useState } from "react"
import { fn } from "storybook/test"

import { VscodeImportDialog } from "./vscode-import-dialog"
import { Button } from "@/components/ui/button"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { useSettingsStore } from "@/stores/settings/settings-store"
import { makeAppSettings } from "@/lib/storybook/fixtures/settings-system"

// Dialog wrapper around VscodeImportForm, triggered from the Theme tab header.
// The Open story renders it expanded; the Toggleable story drives it from a
// button so the open/close transition is visible.
function Toggle() {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button onClick={() => setOpen(true)}>Import VSCode theme</Button>
      <VscodeImportDialog open={open} onOpenChange={setOpen} />
    </>
  )
}

const meta = {
  title: "Settings/Appearance/VscodeImportDialog",
  component: VscodeImportDialog,
  parameters: { layout: "centered" },
  args: { open: false, onOpenChange: fn() },
  beforeEach: () => {
    resetStore(useSettingsStore)
    seedStore(useSettingsStore, { loaded: true, settings: makeAppSettings() })
  },
} satisfies Meta<typeof VscodeImportDialog>

export default meta
type Story = StoryObj<typeof meta>

// Open dialog showing the import form.
export const Open: Story = {
  args: { open: true },
}

// Closed, driven by a trigger button.
export const Toggleable: Story = {
  render: () => <Toggle />,
}

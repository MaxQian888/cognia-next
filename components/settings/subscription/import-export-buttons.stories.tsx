import type { Meta, StoryObj } from "@storybook/nextjs"

import { ImportExportButtons } from "./import-export-buttons"

// `ImportExportButtons` is a propless card with two buttons that open the
// encrypted export / import dialogs (passphrase + file preview live inside
// those dialogs). The default render shows the card; the Export / Import
// stories auto-open each dialog via a play function so the passphrase flow is
// reviewable in isolation.
const meta = {
  title: "Settings/Subscription/ImportExportButtons",
  component: ImportExportButtons,
  parameters: { layout: "padded" },
} satisfies Meta<typeof ImportExportButtons>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

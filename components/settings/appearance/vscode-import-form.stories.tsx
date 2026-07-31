import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { VscodeImportForm } from "./vscode-import-form"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { useSettingsStore } from "@/stores/settings/settings-store"
import { makeAppSettings } from "@/lib/storybook/fixtures/settings-system"

// Reusable VSCode color-theme import form (.json + .vsix drop zone). Writes
// imported themes through the settings store; the dropzone renders in its idle
// state with no file picked.
const meta = {
  title: "Settings/Appearance/VscodeImportForm",
  component: VscodeImportForm,
  parameters: { layout: "padded" },
  beforeEach: () => {
    resetStore(useSettingsStore)
    seedStore(useSettingsStore, { loaded: true, settings: makeAppSettings() })
  },
} satisfies Meta<typeof VscodeImportForm>

export default meta
type Story = StoryObj<typeof meta>

// With the description blurb (tab surface).
export const WithDescription: Story = {}

// Without the blurb (the dialog surface passes showDescription=false).
export const NoDescription: Story = {
  args: { showDescription: false, onComplete: fn() },
}

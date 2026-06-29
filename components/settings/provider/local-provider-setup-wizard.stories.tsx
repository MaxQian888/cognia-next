import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { LocalProviderSetupWizard } from "./local-provider-setup-wizard"

// Step-by-step setup guide for local inference engines. Install instructions
// and config come from the provider catalog at render — fully inert. The
// "Verify connection" step only runs (and may hit a local server) on click; the
// initial "download" step is shown by default. Pure props (providerId).

const meta = {
  title: "Settings/Provider/LocalProviderSetupWizard",
  component: LocalProviderSetupWizard,
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <div className="mx-auto max-w-xl">
        <Story />
      </div>
    ),
  ],
  args: {
    providerId: "ollama",
    onComplete: fn(),
  },
} satisfies Meta<typeof LocalProviderSetupWizard>

export default meta
type Story = StoryObj<typeof meta>

// Ollama setup, starting on the download step.
export const Ollama: Story = {}

// LM Studio setup — different download URL / install steps, no Ollama-specific
// shell commands.
export const LmStudio: Story = {
  args: {
    providerId: "lmstudio",
  },
}

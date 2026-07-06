import type { Meta, StoryObj } from "@storybook/nextjs"

import { LspServerHint } from "./lsp-server-hint"
import { useLspStatusStore } from "@/lib/lsp/lsp-status-store"
import type { LspServerStatus } from "@/types/lsp/config"

function seedStatus(over: Partial<LspServerStatus>) {
  useLspStatusStore.setState({
    statuses: {
      typescript: {
        serverId: "typescript",
        install: "installed",
        npmPackage: "typescript-language-server",
        health: "running",
        restarts: 0,
        ...over,
      },
    },
    installProgress: {},
  })
}

// Non-intrusive editor banner shown when the language server for the open
// document is missing or broken. Renders nothing while everything is healthy.
const meta = {
  title: "Editor/LspServerHint",
  component: LspServerHint,
  args: { language: "typescript" },
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <div className="w-[560px]">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof LspServerHint>

export default meta
type Story = StoryObj<typeof meta>

export const MissingServer: Story = {
  beforeEach: () => seedStatus({ install: "missing" }),
}

export const BrokenServer: Story = {
  beforeEach: () => seedStatus({ install: "installed", health: "broken" }),
}

// Healthy server → the hint renders nothing.
export const Healthy: Story = {
  beforeEach: () => seedStatus({ install: "installed", health: "running" }),
  render: (args) => (
    <div className="rounded border border-dashed px-3 py-2 text-xs text-muted-foreground">
      renders nothing → <LspServerHint {...args} />
    </div>
  ),
}

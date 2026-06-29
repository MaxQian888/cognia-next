import type { Meta, StoryObj } from "@storybook/nextjs"

import { LspServerStatusBadge } from "./lsp-server-status-badge"
import type { LspServerStatus } from "@/types/lsp/config"

// `LspServerStatusBadge` renders the compact binary-detection + runtime-health
// badges for one LSP server row. It renders nothing when `status` is undefined
// (web/mobile, where the status store is inert). Pure — driven entirely by the
// `status` / `progress` props.
const base: LspServerStatus = {
  serverId: "typescript",
  install: "installed",
  resolvedPath: "/usr/local/bin/typescript-language-server",
  health: "stopped",
  restarts: 0,
} as LspServerStatus

const meta = {
  title: "Settings/Lsp/LspServerStatusBadge",
  component: LspServerStatusBadge,
  parameters: { layout: "centered" },
  args: { status: base },
} satisfies Meta<typeof LspServerStatusBadge>

export default meta
type Story = StoryObj<typeof meta>

// Installed binary, not started this session (stopped → no health badge).
export const Installed: Story = {}

// Installed + running this session.
export const Running: Story = {
  args: { status: { ...base, health: "running" } as LspServerStatus },
}

// Crashed with restart count.
export const Crashed: Story = {
  args: {
    status: {
      ...base,
      health: "crashed",
      restarts: 3,
      lastError: "exit code 101",
    } as LspServerStatus,
  },
}

// Binary missing — destructive detection badge.
export const Missing: Story = {
  args: {
    status: { ...base, install: "missing", resolvedPath: undefined } as LspServerStatus,
  },
}

// One-click install in progress — phase badge replaces the detection badge.
export const Installing: Story = {
  args: {
    status: { ...base, install: "missing" } as LspServerStatus,
    progress: { serverId: "typescript", phase: "installing" } as never,
  },
}

// No status known (web/mobile) — renders nothing.
export const Unknown: Story = {
  args: { status: undefined },
}

import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { PermissionModeSelect } from "./permission-mode-select"

// Select over permission modes. `flavor="sdk"` exposes the four SDK modes;
// `flavor="acp"` adds `dontAsk`; supplying `protocol` narrows the list to the
// modes a specific external-agent backend can actually enforce.
const meta = {
  title: "Scheduler/PayloadEditors/PermissionModeSelect",
  component: PermissionModeSelect,
  parameters: { layout: "padded" },
  args: {
    onChange: fn(),
    testId: "permission-mode",
  },
} satisfies Meta<typeof PermissionModeSelect>

export default meta
type Story = StoryObj<typeof meta>

// SDK flavor, no explicit selection → "use default" sentinel shown.
export const SdkDefault: Story = {
  args: { flavor: "sdk", value: undefined },
}

// SDK flavor with an explicit mode selected.
export const SdkAcceptEdits: Story = {
  args: { flavor: "sdk", value: "acceptEdits" },
}

// ACP flavor adds the extra `dontAsk` option.
export const AcpDontAsk: Story = {
  args: { flavor: "acp", value: "dontAsk" },
}

// Protocol-narrowed list (Codex has no `dontAsk`) — takes precedence over flavor.
export const ProtocolCodex: Story = {
  args: { protocol: "codex-app-server", value: "default" },
}

// Disabled (read-only).
export const Disabled: Story = {
  args: { flavor: "acp", value: "plan", disabled: true },
}

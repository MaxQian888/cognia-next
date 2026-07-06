import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { PluginPreInstallDialog, type PreInstallTarget } from "./plugin-pre-install-dialog"

// Sequential pre-install gate: Conflict → Permission → Binaries → Config. The
// parent owns the step state; this controlled component renders only the active
// step for the given `target` (closed when `target` is null) and emits
// Continue / Cancel.

const meta = {
  title: "Plugins/Dialogs/PluginPreInstallDialog",
  component: PluginPreInstallDialog,
  args: { onContinue: fn(), onCancel: fn() },
  parameters: { layout: "centered" },
} satisfies Meta<typeof PluginPreInstallDialog>

export default meta
type Story = StoryObj<typeof meta>

const base: Pick<PreInstallTarget, "pluginId" | "pluginName" | "totalSteps"> = {
  pluginId: "com.acme.web-tools",
  pluginName: "Web Tools",
  totalSteps: 3,
}

// Step 1 — conflict warnings of mixed severity.
export const ConflictStep: Story = {
  args: {
    target: {
      ...base,
      step: "conflict",
      stepNumber: 1,
      conflict: {
        pluginId: base.pluginId,
        reasons: [
          { severity: "high", message: "Overrides the built-in screenshot tool." },
          { severity: "low", message: "Declares a command id already used by another plugin." },
        ],
      },
    },
  },
}

// Step 2 — permission review, including a dangerous permission + network access.
export const PermissionStep: Story = {
  args: {
    target: {
      ...base,
      step: "permission",
      stepNumber: 2,
      permission: {
        pluginId: base.pluginId,
        declared: ["network:fetch", "shell:execute"],
        optional: ["clipboard:read"],
        networkAccess: {
          allowedDomains: ["api.example.com", "*.acme.dev"],
          reasoning: "Fetches the pages you ask about.",
        },
      },
    },
  },
}

// Step 3 — required-binaries check.
export const BinariesStep: Story = {
  args: {
    target: {
      ...base,
      step: "binaries",
      stepNumber: 3,
      binaries: {
        pluginId: base.pluginId,
        missing: [
          { name: "rg", minVersion: "13.0.0" },
          { name: "ffmpeg", minVersion: "6.0", detectedVersion: "4.4" },
        ],
      },
    },
  },
}

// Final step — schema-driven configuration.
export const ConfigStep: Story = {
  args: {
    target: {
      ...base,
      step: "config",
      stepNumber: 3,
      config: {
        pluginId: base.pluginId,
        configSchema: {
          type: "object",
          properties: {
            apiBase: { type: "string", title: "API base URL", default: "https://api.example.com" },
            maxResults: { type: "number", title: "Max results", default: 10 },
          },
        },
      },
    },
  },
}

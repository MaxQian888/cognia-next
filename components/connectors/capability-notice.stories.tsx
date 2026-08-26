import type { Meta, StoryObj } from "@storybook/nextjs"

import { Button } from "@/components/ui/button"

import { CapabilityNotice } from "./capability-notice"

// The one vocabulary for the six causes. Stories exist per cause because the
// difference between them IS the feature: four end in a next step, two end
// with "there is nothing to do", and a layout that made those look alike would
// undo the point.
const meta = {
  title: "Connectors/CapabilityNotice",
  component: CapabilityNotice,
  parameters: { layout: "padded" },
} satisfies Meta<typeof CapabilityNotice>

export default meta
type Story = StoryObj<typeof meta>

export const MissingOAuthScope: Story = {
  args: {
    availability: {
      available: false,
      capability: "history.fetch",
      cause: "missing_oauth_scope",
      detail: "channels:history | groups:history | im:history | mpim:history",
      actionable: true,
    },
  },
}

export const TransportUnsupported: Story = {
  args: {
    availability: {
      available: false,
      capability: "presence.status",
      cause: "transport_unsupported",
      detail: "gateway",
      actionable: true,
    },
  },
}

export const UpstreamUnsupported: Story = {
  args: {
    availability: {
      available: false,
      capability: "send.reaction",
      cause: "upstream_impl_unsupported",
      detail: "set_msg_emoji_like",
      actionable: true,
    },
  },
}

export const InstanceSettingOff: Story = {
  args: {
    availability: {
      available: false,
      capability: "typing",
      cause: "instance_setting_off",
      detail: "assistantAppEnabled",
      actionable: true,
    },
  },
}

/** No remedy: where the conversation lives is not a setting. */
export const SceneUnsupported: Story = {
  args: {
    availability: {
      available: false,
      capability: "send.reaction",
      cause: "scene_unsupported",
      detail: "channel",
      actionable: false,
    },
  },
}

/** No remedy either, and the majority case across the eleven platforms. */
export const NotDeclared: Story = {
  args: {
    availability: {
      available: false,
      capability: "send.reply",
      cause: "not_declared",
      actionable: false,
    },
  },
}

/** With a caller-supplied repair — the shape `UsagePresence` mounts. */
export const WithRepairAction: Story = {
  args: {
    availability: {
      available: false,
      capability: "presence.status",
      cause: "not_declared",
      actionable: false,
    },
    action: (
      <Button type="button" variant="outline" size="sm">
        Switch to the in-chat card
      </Button>
    ),
  },
}

import { useEffect } from "react"
import type { Meta, StoryObj } from "@storybook/nextjs"

import { PluginConsentOverlay } from "./plugin-consent-overlay"
import {
  PLUGIN_CONSENT_REQUEST_EVENT,
  type PluginConsentRequestEvent,
} from "@/lib/plugin/security/consent-broker"

// Floating consent prompt for tier-"confirm" plugin permissions. The overlay
// listens for an in-renderer `plugin:consent-request` CustomEvent and renders a
// three-button card with a countdown; with no pending request it renders
// nothing. The decorator dispatches a request event after the overlay mounts so
// the prompt is visible in Storybook.

function emit(detail: PluginConsentRequestEvent) {
  window.dispatchEvent(new CustomEvent(PLUGIN_CONSENT_REQUEST_EVENT, { detail }))
}

function ConsentEmitter({ detail }: { detail: PluginConsentRequestEvent }) {
  useEffect(() => {
    emit(detail)
  }, [detail])
  return null
}

const meta = {
  title: "Plugins/Dialogs/PluginConsentOverlay",
  component: PluginConsentOverlay,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof PluginConsentOverlay>

export default meta
type Story = StoryObj<typeof meta>

// A pending request for a dangerous filesystem-write permission.
export const PendingRequest: Story = {
  decorators: [
    (Story) => (
      <>
        <Story />
        <ConsentEmitter
          detail={{
            requestId: "req-1",
            pluginId: "com.acme.web-tools",
            permission: "filesystem:write",
            reason: "Save the exported report to your Downloads folder.",
            timeoutMs: 30_000,
          }}
        />
      </>
    ),
  ],
}

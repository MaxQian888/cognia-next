import type { Meta, StoryObj } from "@storybook/nextjs"

import { SdkCapabilitiesCard } from "./sdk-capabilities-card"

// `SdkCapabilitiesCard` is a Tauri-only diagnostics surface: it reads the live
// Claude Agent SDK session's authoritative model + slash-command lists via
// `useSdkSessionCapabilities`, which is gated on `isTauri()` + an open Anthropic
// session. On the web preview those preconditions never hold, so the hook
// returns null lists and the card renders nothing (`return null`). This story
// documents that web/empty branch; the populated grid only appears inside the
// desktop shell with a live SDK session.
const meta = {
  title: "Settings/AgentRuntime/SdkCapabilitiesCard",
  component: SdkCapabilitiesCard,
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <div className="max-w-2xl">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof SdkCapabilitiesCard>

export default meta
type Story = StoryObj<typeof meta>

// Web preview: no live Anthropic SDK session, so the card self-hides.
export const WebHidden: Story = {}

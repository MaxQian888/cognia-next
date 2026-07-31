import type { Meta, StoryObj } from "@storybook/nextjs"

import { WebRtcCard } from "./webrtc-card"

// WebRTC remote-access settings (ADR-0021). Hydrates its form from the Dexie
// `settings` singleton on mount; with the fresh in-browser DB it falls back to
// the INITIAL defaults (enabled, default signaling URL, the two Google/
// Cloudflare STUN servers, no TURN provider). The Rust signaling poll is
// Tauri-gated so the status pane stays hidden in the browser. No props.
const meta = {
  title: "Settings/Companion/WebRtcCard",
  component: WebRtcCard,
  parameters: { layout: "padded" },
} satisfies Meta<typeof WebRtcCard>

export default meta
type Story = StoryObj<typeof meta>

// Default form: master toggle on, default signaling URL + STUN list, TURN
// provider set to "none" (the dependent key/SID/token inputs stay collapsed).
export const Default: Story = {}

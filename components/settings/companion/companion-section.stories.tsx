import type { Meta, StoryObj } from "@storybook/nextjs"

import { CompanionSection } from "./companion-section"

// `CompanionSection` is a Tauri-branching surface: the server / tunnel / mDNS /
// WebRTC cards all call `isTauri()` and fall back to a disabled "desktop only"
// state in the browser. Storybook runs the WEB branch, so the controls render
// disabled and the status badges read "web". The pairing, push and sync cards
// (which read Dexie via `useLiveQuery`) render their empty states against the
// fresh in-browser IndexedDB.
const meta = {
  title: "Settings/Companion/CompanionSection",
  component: CompanionSection,
  parameters: { layout: "padded" },
} satisfies Meta<typeof CompanionSection>

export default meta
type Story = StoryObj<typeof meta>

// Web branch: every Tauri-gated control is disabled, the server status badge
// reads "web", and the device / push tables show their empty states.
export const Default: Story = {}

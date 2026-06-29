import type { Meta, StoryObj } from "@storybook/nextjs"

import { ExternalBridgeSection } from "./external-bridge-section"

// External Bridge (MCP server) settings: server status, exposed surfaces, and
// the MCP access audit log (Dexie-backed via useLiveQuery). The server control
// is Tauri-gated; the browser renders the disabled/empty state. No props.
const meta = {
  title: "Settings/ExternalBridge/ExternalBridgeSection",
  component: ExternalBridgeSection,
  parameters: { layout: "padded" },
} satisfies Meta<typeof ExternalBridgeSection>

export default meta
type Story = StoryObj<typeof meta>

// Web branch: audit log empty, server controls disabled.
export const Default: Story = {}

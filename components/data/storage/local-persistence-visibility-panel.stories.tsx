import type { Meta, StoryObj } from "@storybook/nextjs"

import { LocalPersistenceVisibilityPanel } from "./local-persistence-visibility-panel"
import type { LocalPersistenceVisibilityProjection } from "@/lib/storage"

// Backend-runtime status card. With no `projection` it computes one from the
// active runtime (Dexie-only here). Pass a projection to story the degraded /
// mirrored-domain states.
const meta = {
  title: "Data/LocalPersistenceVisibilityPanel",
  component: LocalPersistenceVisibilityPanel,
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <div className="w-96">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof LocalPersistenceVisibilityPanel>

export default meta
type Story = StoryObj<typeof meta>

// Uses the runtime-computed projection.
export const Default: Story = {}

export const Healthy: Story = {
  args: {
    projection: {
      modeLabel: "Local-first",
      activeBackendLabel: "Web (IndexedDB)",
      isDegraded: false,
      summary: "All data persists to IndexedDB in this browser.",
      diagnosticMessages: [],
      mirroredDomains: [
        { id: "chat", label: "Chat", status: "completed" },
        { id: "settings", label: "Settings", status: "completed" },
      ],
      reconciliationLabel: "Reconciled (2 domains)",
    } satisfies LocalPersistenceVisibilityProjection,
  },
}

export const Degraded: Story = {
  args: {
    projection: {
      modeLabel: "Local-first",
      activeBackendLabel: "Fallback",
      isDegraded: true,
      summary: "The preferred backend is unavailable; running on a fallback store.",
      diagnosticMessages: ["IndexedDB quota exceeded — some writes may be dropped."],
      mirroredDomains: [
        { id: "chat", label: "Chat", status: "degraded" },
        { id: "vectors", label: "Vectors", status: "unavailable" },
      ],
      reconciliationLabel: "Reconciliation pending",
    } satisfies LocalPersistenceVisibilityProjection,
  },
}

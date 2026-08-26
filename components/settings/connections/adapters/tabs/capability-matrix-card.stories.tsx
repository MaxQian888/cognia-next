import type { Meta, StoryObj } from "@storybook/nextjs"

import type { AdapterInstanceRow } from "@/lib/db/connector-types"

import { CapabilityMatrixCard } from "./capability-matrix-card"

// The card now renders the shared vocabulary
// (`components/connectors/capability-notice.tsx`) rather than its own copy, so
// these stories double as a check that reason + next step still read as one
// line inside the compact list.
function row(patch: Partial<AdapterInstanceRow> = {}): AdapterInstanceRow {
  return {
    id: "cai_1",
    type: "slack",
    displayName: "Workspace bot",
    enabled: true,
    transportMode: "gateway",
    settings: {},
    credentialsRef: { keyringService: "com.cognia.platforms", accounts: [] },
    trigger: { rules: [], blockers: [], storeUnmatchedInDraftMode: false },
    defaultMode: "auto",
    mediaModelPolicy: "local_extract_only",
    createdAt: 0,
    updatedAt: 0,
    ...patch,
  } as AdapterInstanceRow
}

const meta = {
  title: "Settings/Connections/CapabilityMatrixCard",
  component: CapabilityMatrixCard,
  parameters: { layout: "padded" },
} satisfies Meta<typeof CapabilityMatrixCard>

export default meta
type Story = StoryObj<typeof meta>

/** No evidence of a gap — the projection fails open, so everything is listed. */
export const AllAvailable: Story = { args: { row: row() } }

/** A workspace that only ever granted `chat:write`: several rows, one reason. */
export const NarrowSlackGrant: Story = {
  args: {
    row: row({ settings: { connectedScopes: { scopes: ["chat:write"], grantedAtMs: 1 } } }),
  },
}

/** A OneBot upstream whose probe reported a short feature list. */
export const LimitedUpstream: Story = {
  args: {
    row: row({
      type: "onebot",
      implMetadata: { appName: "Lagrange", features: ["send_msg"] },
    }),
  },
}

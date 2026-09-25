import type { Meta, StoryObj } from "@storybook/nextjs"
import type { ReactNode } from "react"

import {
  DEFAULT_GATEWAY_CONFIG,
  type GatewayBindTimeField,
  type GatewayConfig,
  type GatewayKeyCooldown,
  type GatewayRequestLogRow,
  type GatewayStatus,
} from "@/types/gateway"

import { appendGatewayRequestLog, clearGatewayRequestLog } from "@/lib/db/gateway-request-log"

import { GatewayRestartBanner } from "./components/restart-banner"
import { GatewayLogViewer } from "./gateway-log-viewer"
import type { GatewayPanelContext } from "./gateway-section"
import { GatewayListenerPanel } from "./panels/listener-panel"
import { GatewayOverviewPanel } from "./panels/overview-panel"
import { GatewayReliabilityPanel } from "./panels/reliability-panel"
import { GatewayUpstreamPanel } from "./panels/upstream-panel"

// `GatewaySection` renders only the desktop-only notice in a browser (see
// `gateway-section.stories.tsx`), but the config panels take everything they
// show as props. These stories feed them a running gateway and frame them in a
// box with the same container names as the real detail pane, so the
// container-query layout can be checked at a chosen pane width.

const PENDING: GatewayBindTimeField[] = ["port", "allowlist"]

const status: GatewayStatus = {
  running: true,
  boundPort: 47823,
  hasToken: true,
  bindInterface: "lan",
  pendingRestartFields: PENDING,
  callsTotal: 18_432,
  lastCallAt: new Date(Date.now() - 95_000).toISOString(),
  snapshotGeneratedAtMs: Date.now() - 12 * 60_000,
  snapshotProviderCount: 4,
  snapshotAliasCount: 9,
  localRoutingEnabled: true,
  routingPolicyRevision: "rev-2026-09-25",
  routingStrategy: "least-busy",
}

const config: GatewayConfig = {
  ...DEFAULT_GATEWAY_CONFIG,
  enabled: true,
  port: 50001,
  bindInterface: "lan",
  allowlist: ["127.0.0.1/32"],
}

const ctx: GatewayPanelContext = {
  config,
  status,
  persist: async () => {},
  replace: async () => {},
  pendingRestartFields: PENDING,
}

const logRows: GatewayRequestLogRow[] = [
  {
    id: "story-1",
    at: new Date(Date.now() - 20_000).toISOString(),
    route: "/v1/messages",
    remoteIp: "127.0.0.1",
    keyId: null,
    model: "claude-sonnet-5",
    providerId: "anthropic",
    status: 200,
    latencyMs: 1840,
    inputTokens: 12_400,
    outputTokens: 860,
    error: null,
    stream: true,
    strategy: "least-busy",
    distribution: "weighted",
    selectedDeployment: "anthropic-primary",
    routingLatencyMs: 2,
    policyRevision: "rev-2026-09-25",
    fallbackReason: "openai-pool rate limited",
    keyFingerprint: "…7d13",
    attempts: [
      {
        providerId: "openai",
        modelId: "gpt-5",
        status: 429,
        latencyMs: 210,
        reason: "429 Too Many Requests",
      },
      { providerId: "anthropic", modelId: "claude-sonnet-5", status: 200, latencyMs: 1620 },
    ],
  },
  {
    id: "story-2",
    at: new Date(Date.now() - 90_000).toISOString(),
    route: "/v1/chat/completions",
    remoteIp: "192.168.1.20",
    keyId: null,
    model: "fast",
    providerId: "groq",
    status: 502,
    latencyMs: 30_012,
    inputTokens: null,
    outputTokens: null,
    error: "upstream closed the connection before sending a response",
    stream: false,
  },
  {
    id: "story-3",
    at: new Date(Date.now() - 300_000).toISOString(),
    route: "/v1/messages/count_tokens",
    remoteIp: "127.0.0.1",
    keyId: null,
    model: "claude-sonnet-5",
    providerId: null,
    status: 200,
    latencyMs: 1,
    inputTokens: 3_100,
    outputTokens: 0,
    error: null,
    stream: false,
    synthesized: true,
  },
]

const cooldowns: GatewayKeyCooldown[] = [
  {
    providerId: "openai",
    keyHint: "…4f2a",
    untilMs: Date.now() + 42_000,
    permanent: false,
    reason: "429 Too Many Requests",
  },
  {
    providerId: "openai",
    keyHint: "…91c0",
    untilMs: 0,
    permanent: true,
    reason: "insufficient_quota",
  },
  {
    providerId: "anthropic",
    keyHint: "…7d13",
    untilMs: Date.now() + 8 * 60_000,
    permanent: false,
    reason: "529 overloaded",
  },
]

function Pane({ width, children }: { width: number; children: ReactNode }) {
  return (
    <div className="bg-background p-4">
      <div
        style={{ width }}
        className="flex h-[760px] min-h-0 flex-col overflow-hidden rounded-lg border @container/gateway-shell"
      >
        <GatewayRestartBanner pending={PENDING} restarting={false} onRestart={() => {}} />
        <div className="min-h-0 flex-1 overflow-y-auto p-3 @container/gateway-pane @lg/gateway-shell:p-4">
          {children}
        </div>
      </div>
    </div>
  )
}

interface PaneArgs {
  paneWidth: number
}

const meta: Meta<PaneArgs> = {
  title: "Settings/Gateway/Panels",
  parameters: { layout: "fullscreen" },
  args: { paneWidth: 640 },
  argTypes: { paneWidth: { control: { type: "range", min: 320, max: 1000, step: 20 } } },
}

export default meta
type Story = StoryObj<PaneArgs>

export const Overview: Story = {
  render: ({ paneWidth }) => (
    <Pane width={paneWidth}>
      <GatewayOverviewPanel
        ctx={ctx}
        starting={false}
        onToggleEnabled={async () => {}}
        onRefreshStatus={async () => {}}
      />
    </Pane>
  ),
}

export const Listener: Story = {
  render: ({ paneWidth }) => (
    <Pane width={paneWidth}>
      <GatewayListenerPanel ctx={ctx} />
    </Pane>
  ),
}

export const Reliability: Story = {
  render: ({ paneWidth }) => (
    <Pane width={paneWidth}>
      <GatewayReliabilityPanel ctx={ctx} />
    </Pane>
  ),
}

export const Upstream: Story = {
  render: ({ paneWidth }) => (
    <Pane width={paneWidth}>
      <GatewayUpstreamPanel ctx={ctx} cooldowns={cooldowns} onRefreshCooldowns={async () => {}} />
    </Pane>
  ),
}

/** The narrowest pane the detail column gets before the rail becomes a sheet. */
export const NarrowListener: Story = {
  args: { paneWidth: 360 },
  render: Listener.render,
}

/** Seeds Storybook's own IndexedDB; the viewer reads it through the live query. */
export const RequestLog: Story = {
  loaders: [
    async () => {
      await clearGatewayRequestLog()
      for (const row of logRows) await appendGatewayRequestLog(row)
      return {}
    },
  ],
  render: ({ paneWidth }) => (
    <Pane width={paneWidth}>
      <GatewayLogViewer />
    </Pane>
  ),
}

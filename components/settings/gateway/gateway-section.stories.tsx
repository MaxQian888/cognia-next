import type { Meta, StoryObj } from "@storybook/nextjs"
import type { ReactElement } from "react"

import { setTransport, transport as initialTransport } from "@/lib/tauri"
import type { Transport } from "@/lib/tauri/transport-types"
import {
  DEFAULT_GATEWAY_CONFIG,
  GATEWAY_BIND_TIME_FIELDS,
  type GatewayApiKey,
  type GatewayApiKeyPatch,
  type GatewayApiKeyRedacted,
  type GatewayConfig,
  type GatewayKeyCooldown,
  type GatewayStatus,
} from "@/types/gateway"

import { GatewaySection } from "./gateway-section"

// `GatewaySection` is desktop-only (the inbound LLM gateway lives in the Tauri
// runtime). In a plain browser `isTauri()` is false and the section renders
// the "desktop only" notice before it builds the master/detail shell — the
// `WebOnly` story keeps that branch visible.
//
// The `Desktop*` stories reach the real shell: `beforeEach` marks the window as
// a Tauri webview for the life of the story and swaps the IPC transport for an
// in-memory gateway, so every panel renders against the same commands Rust
// serves (config, status, keys, cooldowns, tickets) and the edits round-trip.
// Both are restored when the story unmounts.

interface FixtureState {
  config: GatewayConfig
  status: GatewayStatus
  /** Config the listener was started with — the source of `pendingRestartFields`. */
  boundConfig: GatewayConfig | null
  keys: GatewayApiKey[]
  cooldowns: GatewayKeyCooldown[]
}

function baseStatus(): GatewayStatus {
  return {
    running: false,
    boundPort: null,
    hasToken: false,
    bindInterface: "loopback",
    pendingRestartFields: [],
    callsTotal: 0,
    lastCallAt: null,
    snapshotGeneratedAtMs: Date.now() - 4 * 60_000,
    snapshotProviderCount: 3,
    snapshotAliasCount: 6,
    localRoutingEnabled: true,
    routingPolicyRevision: "rev-2026-09-30",
    routingStrategy: "least-busy",
  }
}

function redact(key: GatewayApiKey): GatewayApiKeyRedacted {
  const { secret, ...rest } = key
  return { ...rest, secretPreview: `sk-cognia-…${secret.slice(-4)}` }
}

/** An in-memory stand-in for the Rust gateway commands the panels call. */
function createFixtureTransport(state: FixtureState): Transport {
  const sync = () => {
    state.status = {
      ...state.status,
      hasToken: state.keys.some((k) => k.enabled),
      bindInterface: (state.boundConfig ?? state.config).bindInterface,
      pendingRestartFields: state.boundConfig
        ? GATEWAY_BIND_TIME_FIELDS.filter(
            (field) =>
              JSON.stringify(state.boundConfig?.[field]) !== JSON.stringify(state.config[field])
          )
        : [],
    }
  }
  sync()
  let nextId = state.keys.length + 1

  const handlers: Record<string, (args: Record<string, unknown>) => unknown> = {
    gateway_get_config: () => structuredClone(state.config),
    gateway_get_status: () => structuredClone(state.status),
    gateway_update_config: (args) => {
      state.config = structuredClone(args.config as GatewayConfig)
      sync()
    },
    gateway_start: () => {
      if (!state.status.hasToken) throw new Error("no usable API key")
      state.boundConfig = structuredClone(state.config)
      state.status = { ...state.status, running: true, boundPort: state.config.port }
      sync()
    },
    gateway_stop: () => {
      state.boundConfig = null
      state.status = { ...state.status, running: false, boundPort: null }
      sync()
    },
    gateway_list_cooldowns: () => structuredClone(state.cooldowns),
    gateway_reset_cooldowns: (args) => {
      const provider = args.providerId as string | undefined
      const before = state.cooldowns.length
      state.cooldowns = provider ? state.cooldowns.filter((c) => c.providerId !== provider) : []
      return before - state.cooldowns.length
    },
    gateway_list_keys: () => state.keys.map(redact),
    gateway_create_key: (args) => {
      const key: GatewayApiKey = {
        id: `key-${nextId}`,
        name: String(args.name),
        secret: `sk-cognia-${Math.random().toString(36).slice(2)}${nextId}`,
        modelAllowlist: (args.modelAllowlist as string[]) ?? [],
        scopes: [],
        expiresAtMs: (args.expiresAtMs as number | null) ?? null,
        enabled: true,
        rateLimitPerMin: (args.rateLimitPerMin as number | null) ?? null,
        quotaTokens: (args.quotaTokens as number | null) ?? null,
        quotaUsedTokens: 0,
        createdAtMs: Date.now(),
        lastUsedAtMs: null,
      }
      nextId += 1
      state.keys.push(key)
      sync()
      return structuredClone(key)
    },
    gateway_update_key: (args) => {
      const key = state.keys.find((k) => k.id === args.id)
      if (!key) throw new Error("unknown key")
      Object.assign(key, args.patch as GatewayApiKeyPatch)
      sync()
    },
    gateway_delete_key: (args) => {
      state.keys = state.keys.filter((k) => k.id !== args.id)
      sync()
    },
    gateway_reset_key_quota: (args) => {
      const key = state.keys.find((k) => k.id === args.id)
      if (key) key.quotaUsedTokens = 0
    },
    gateway_reveal_key: (args) => state.keys.find((k) => k.id === args.id)?.secret ?? null,
    gateway_list_route_tickets: () => [],
    gateway_probe_upstream: () => [
      {
        providerId: "anthropic",
        modelId: "claude-sonnet-5",
        ok: true,
        status: 200,
        latencyMs: 412,
        error: null,
      },
      {
        providerId: "openai",
        modelId: "gpt-5",
        ok: false,
        status: 429,
        latencyMs: 120,
        error: "rate limited",
      },
    ],
  }

  return {
    async call<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
      const handler = handlers[name]
      if (!handler) throw new Error(`fixture transport: ${name} is not stubbed`)
      return handler(args) as T
    },
    subscribe: () => () => {},
  }
}

/**
 * Mark the window as a Tauri webview and route IPC to the fixture, before the
 * story renders. Returns the cleanup Storybook runs when the story unmounts.
 */
function installDesktopFixture(make: () => FixtureState): () => void {
  const win = window as unknown as Record<string, unknown>
  const hadMarker = "__TAURI_INTERNALS__" in win
  if (!hadMarker) win.__TAURI_INTERNALS__ = {}
  const previous = initialTransport
  setTransport(createFixtureTransport(make()))
  return () => {
    setTransport(previous)
    if (!hadMarker) delete win.__TAURI_INTERNALS__
  }
}

function frame(width: number, height = 760) {
  return function FrameDecorator(Story: () => ReactElement) {
    return (
      <div className="p-4" style={{ width, height }}>
        <Story />
      </div>
    )
  }
}

const firstRun = (): FixtureState => ({
  config: { ...DEFAULT_GATEWAY_CONFIG },
  status: baseStatus(),
  boundConfig: null,
  keys: [],
  cooldowns: [],
})

const inUse = (): FixtureState => {
  const config: GatewayConfig = {
    ...DEFAULT_GATEWAY_CONFIG,
    enabled: true,
    bindInterface: "lan",
    allowlist: ["127.0.0.1/32"],
  }
  return {
    config,
    // Started on another port, so the saved one is pending a restart.
    boundConfig: { ...config, port: 47800 },
    status: {
      ...baseStatus(),
      running: true,
      boundPort: 47800,
      callsTotal: 1284,
      lastCallAt: new Date(Date.now() - 42_000).toISOString(),
    },
    keys: [
      {
        id: "key-laptop",
        name: "Claude Code laptop",
        secret: "sk-cognia-laptop-a1b2",
        modelAllowlist: [],
        scopes: ["runs:create", "runs:read"],
        expiresAtMs: null,
        enabled: true,
        rateLimitPerMin: 120,
        quotaTokens: 2_000_000,
        quotaUsedTokens: 1_730_000,
        createdAtMs: Date.now() - 20 * 86_400_000,
        lastUsedAtMs: Date.now() - 42_000,
      },
      {
        id: "key-ci",
        name: "CI runner",
        secret: "sk-cognia-ci-c3d4",
        modelAllowlist: ["fast"],
        scopes: [],
        expiresAtMs: Date.now() + 9 * 86_400_000,
        enabled: false,
        rateLimitPerMin: null,
        quotaTokens: null,
        quotaUsedTokens: 0,
        createdAtMs: Date.now() - 3 * 86_400_000,
        lastUsedAtMs: null,
      },
    ],
    cooldowns: [
      {
        providerId: "openai",
        keyHint: "…9f2c",
        untilMs: Date.now() + 95_000,
        permanent: false,
        reason: "429 rate_limit_exceeded",
      },
      {
        providerId: "groq",
        keyHint: "…11ab",
        untilMs: 0,
        permanent: true,
        reason: "insufficient_quota",
      },
    ],
  }
}

const meta = {
  title: "Settings/Gateway/GatewaySection",
  component: GatewaySection,
  parameters: { layout: "fullscreen", nextjs: { appDirectory: true } },
} satisfies Meta<typeof GatewaySection>

export default meta
type Story = StoryObj<typeof meta>

/** Outside the desktop shell: the notice, and no IPC. */
export const WebOnly: Story = {
  decorators: [frame(960, 720)],
}

function desktop(
  make: () => FixtureState,
  gatewayPanel: string,
  width = 1040,
  extraQuery: Record<string, string> = {}
): Story {
  return {
    parameters: {
      nextjs: {
        appDirectory: true,
        navigation: { query: { section: "gateway", gatewayPanel, ...extraQuery } },
      },
    },
    beforeEach: () => installDesktopFixture(make),
    decorators: [frame(width)],
  }
}

/** A first visit: no key, stopped — the setup steps lead. */
export const DesktopFirstRun = desktop(firstRun, "overview")
/** First visit to API keys: the create form is open and cannot be dismissed. */
export const DesktopKeysEmpty = desktop(firstRun, "keys")
/** A running gateway with traffic, a pending restart and parked accounts. */
export const DesktopOverview = desktop(inUse, "overview")
export const DesktopKeys = desktop(inUse, "keys")
export const DesktopListener = desktop(inUse, "listener")
export const DesktopReliability = desktop(inUse, "reliability")
export const DesktopUpstream = desktop(inUse, "upstream")
/** The log opened from a key's usage line, narrowed to that key. */
export const DesktopLogsForKey = desktop(inUse, "logs", 1040, { gatewayLogKey: "key-laptop" })
/** A narrow pane: the nav collapses and the panels stack. */
export const DesktopNarrow = desktop(inUse, "overview", 560)

/**
 * Plugin Connectors API (`ctx.connectors`) — the full plugin-facing surface
 * of the Platform Connectors / IM subsystem. Lets plugins enumerate the
 * user's connected platforms, observe inbound messages **and** interactive
 * callbacks, drive outbound messaging (send / edit / delete / typing /
 * upload), read history + runtime health, and — behind a separate dangerous
 * permission — manage the adapter instance configuration itself.
 *
 * Wraps the connector `ConnectorBus` (`lib/connectors/bus.ts`), the
 * `adapterInstances` Dexie table (`lib/db/adapter-instances.ts`), and the
 * outbound runner's runtime-state snapshot
 * (`lib/connectors/outbound-runner.ts`).
 *
 * PERMISSION MODEL (three tiers, gated via `createGuardedAPI`):
 *  - `connectors:read`   — read-only: list adapters + instances, observe
 *    inbound/callbacks, fetch history, read runtime health. Returns only
 *    credential-free summaries — never the live `PlatformAdapter` (whose
 *    `start`/`stop`/`refreshCredentials` could be abused) and never the
 *    instance's `credentialsRef` (the OS-keyring pointer).
 *  - `connectors:send`   — DANGEROUS: outbound mutations that reach real
 *    people on real platforms and can't be recalled (send/edit/delete/
 *    typing/upload).
 *  - `connectors:manage` — DANGEROUS: create / reconfigure / enable /
 *    delete the user's adapter instances (changes live delivery routing).
 *
 * All observers (`onInbound`/`onCallback`) are passive read-only taps; they
 * run before the authoritative routing/handler and cannot alter it.
 */

import { getBus } from "@/lib/connectors/bus"
import { newIdempotencyKey } from "@/types/connectors/outbound"
import { createGuardedAPI } from "@/lib/plugin/security/permission-guard"
import {
  createA2UIBuilder,
  type PluginConnectorsA2UIBuilder,
} from "@/lib/connectors/a2ui-bridge/surface-builder"
import {
  createAdapterInstance,
  updateAdapterInstance,
  deleteAdapterInstance,
  getAdapterInstance,
  listAdapterInstances,
  type AdapterInstanceInput,
} from "@/lib/db/adapter-instances"
import {
  getAdapterRuntimeStateSnapshot,
  type AdapterRuntimeStateSnapshot,
} from "@/lib/connectors/outbound-runner"
import type { AdapterInstanceRow } from "@/lib/db/connector-types"
import type {
  OutboundRequest,
  OutboundResult,
  ConversationReference,
  NormalizedInboundEvent,
  ConnectorCallbackEvent,
  PlatformAdapter,
  PlatformKind,
  Capability,
  AdapterHealth,
  TransportMode,
  AttachmentDescriptor,
  AdapterAttachmentRef,
  HistoryFetchOpts,
  StreamReplyRequest,
  A2UICapabilityMatrix,
} from "@/types/connectors"
import type { PlatformSkillCapability } from "@/types/connectors/skill-capability"

export type { PluginConnectorsA2UIBuilder } from "@/lib/connectors/a2ui-bridge/surface-builder"

/** Optional-method support flags so plugins can feature-detect per adapter. */
export interface PluginConnectorAdapterSupport {
  edit: boolean
  delete: boolean
  setTyping: boolean
  uploadFile: boolean
  fetchHistory: boolean
  streamReply: boolean
}

/** Credential-free runtime summary of a connected adapter. */
export interface PluginConnectorAdapterInfo {
  id: string
  type: PlatformKind
  displayName: string
  version: string
  capabilities: readonly Capability[]
  transportModes: readonly TransportMode[]
  health: AdapterHealth
  supports: PluginConnectorAdapterSupport
}

/**
 * Credential-free view of a configured adapter instance row — the persisted
 * configuration (settings / trigger policy / quiet hours / display name / …)
 * minus the `credentialsRef` keyring pointer.
 */
export type PluginAdapterInstanceInfo = Omit<AdapterInstanceRow, "credentialsRef">

/** Patch shape accepted by `updateInstance` (mirrors the DB whitelist). */
export type PluginAdapterInstancePatch = Parameters<typeof updateAdapterInstance>[1]

/** Input shape accepted by `createInstance` (full instance minus id/timestamps). */
export type PluginAdapterInstanceInput = AdapterInstanceInput

export interface PluginConnectorsAPI {
  // ── Reads (connectors:read) ──────────────────────────────────────────────
  /** Summaries of every connected adapter instance. */
  listAdapters(): PluginConnectorAdapterInfo[]
  /** Summary of one adapter, or `null` if not connected. */
  getAdapter(adapterId: string): PluginConnectorAdapterInfo | null
  /**
   * The adapter's A2UI component-support matrix (per-component-kind
   * `native`/`simulated`/`fallback`/`unsupported`). Lets a plugin pick a
   * rendering strategy per platform before sending. `null` when the adapter
   * is not connected.
   */
  getA2UICapabilityMatrix(adapterId: string): A2UICapabilityMatrix | null
  /**
   * Which built-in skill families the adapter serves on its channel (e.g.
   * `lark.calendar` read+write). `null` when the adapter is not connected,
   * `[]` when it declares none.
   */
  getSkillCapabilities(adapterId: string): readonly PlatformSkillCapability[] | null
  /** Configured adapter instances (credential-free), from the Dexie table. */
  listInstances(): Promise<PluginAdapterInstanceInfo[]>
  /** One configured instance (credential-free), or `null` if not found. */
  getInstance(id: string): Promise<PluginAdapterInstanceInfo | null>
  /**
   * Live outbound runtime health for an adapter (circuit-breaker + token
   * bucket). `null` when the runner isn't running or the adapter has not
   * produced outbound activity yet.
   */
  getRuntimeState(adapterId: string): AdapterRuntimeStateSnapshot | null
  /**
   * Drain an adapter's platform-side message history (when the platform
   * supports it) into a bounded array. `[]` when unsupported. `opts.max`
   * caps the count (default 100).
   */
  fetchHistory(
    adapterId: string,
    conversationKey: string,
    opts?: HistoryFetchOpts
  ): Promise<NormalizedInboundEvent[]>
  /**
   * Observe every inbound platform event the bus processes (passive,
   * read-only — cannot alter routing). Returns a disposer.
   */
  onInbound(handler: (event: NormalizedInboundEvent) => void): () => void
  /**
   * Observe every resolved interactive callback (button / select / form
   * submit / dismiss) with its bound conversation key. Passive, read-only —
   * fires before the authoritative callback handler. Returns a disposer.
   */
  onCallback(
    handler: (event: ConnectorCallbackEvent, boundConversationKey: string | null) => void
  ): () => void

  // ── Outbound mutations (connectors:send, DANGEROUS) ──────────────────────
  /** Send a fully-formed outbound request through an adapter. */
  send(adapterId: string, req: OutboundRequest): Promise<OutboundResult>
  /** Convenience: send a plain-text message to a conversation. */
  sendText(
    adapterId: string,
    conversationRef: ConversationReference,
    text: string
  ): Promise<OutboundResult>
  /** Edit an already-sent message in place (when the platform supports it). */
  editMessage(adapterId: string, messageId: string, patch: OutboundRequest): Promise<OutboundResult>
  /** Delete an already-sent message (when the platform supports it). */
  deleteMessage(adapterId: string, messageId: string): Promise<OutboundResult>
  /**
   * Toggle a typing indicator. Resolves `true` when delivered, `false` when
   * the adapter is missing or the platform has no typing surface.
   */
  setTyping(adapterId: string, conversationKey: string, on: boolean): Promise<boolean>
  /**
   * Upload an attachment, returning the platform reference. `null` when the
   * adapter is missing or the platform has no upload surface.
   */
  uploadFile(adapterId: string, file: AttachmentDescriptor): Promise<AdapterAttachmentRef | null>
  /**
   * Push an incremental assistant reply through an adapter that supports
   * platform-side streaming (e.g. WeCom). `req.text` is the full accumulated
   * reply so far, not a delta. Resolves `true` when streamed, `false` when
   * the adapter is missing or the platform has no streaming surface — so the
   * plugin can fall back to {@link send}.
   */
  streamReply(adapterId: string, req: StreamReplyRequest): Promise<boolean>

  // ── A2UI rich-content builder (pure, ungated) ────────────────────────────
  /**
   * Construct rich, interactive A2UI surfaces (cards / buttons / forms) for
   * outbound messages. Pure local construction — no permission needed; the
   * `send()` that delivers the result is what's gated by `connectors:send`.
   */
  a2ui: PluginConnectorsA2UIBuilder
  /**
   * Mint a fresh idempotency key for an {@link OutboundRequest} built by hand
   * (the `a2ui.message` / `sendText` helpers already do this internally).
   * Pure; no permission required.
   */
  newIdempotencyKey(): string

  // ── Instance management (connectors:manage, DANGEROUS) ───────────────────
  /** Create a new adapter instance configuration; returns its summary. */
  createInstance(input: PluginAdapterInstanceInput): Promise<PluginAdapterInstanceInfo>
  /** Patch a configured instance (whitelisted fields only). */
  updateInstance(id: string, patch: PluginAdapterInstancePatch): Promise<void>
  /** Enable or disable a configured instance. */
  setInstanceEnabled(id: string, enabled: boolean): Promise<void>
  /** Delete a configured instance (also reaps its heartbeat rows). */
  deleteInstance(id: string): Promise<void>
}

function toInfo(a: PlatformAdapter): PluginConnectorAdapterInfo {
  return {
    id: a.id,
    type: a.meta.type,
    displayName: a.meta.displayName,
    version: a.meta.version,
    capabilities: a.meta.capabilities,
    transportModes: a.meta.transportModes,
    health: a.health(),
    supports: {
      edit: typeof a.edit === "function",
      delete: typeof a.delete === "function",
      setTyping: typeof a.setTyping === "function",
      uploadFile: typeof a.uploadFile === "function",
      fetchHistory: typeof a.fetchHistory === "function",
      streamReply: typeof a.streamReply === "function",
    },
  }
}

/** Strip the keyring pointer before any instance row crosses the plugin boundary. */
function toInstanceInfo(row: AdapterInstanceRow): PluginAdapterInstanceInfo {
  const copy: Partial<AdapterInstanceRow> = { ...row }
  delete copy.credentialsRef
  return copy as PluginAdapterInstanceInfo
}

/**
 * Create the Connectors API for a plugin. See the permission model in the
 * file header: reads need `connectors:read`, outbound mutations need
 * `connectors:send`, instance management needs `connectors:manage`.
 */
export function createConnectorsAPI(pluginId: string): PluginConnectorsAPI {
  const api: PluginConnectorsAPI = {
    // ── reads ──────────────────────────────────────────────────────────────
    listAdapters: () => getBus().listAdapters().map(toInfo),
    getAdapter: (adapterId) => {
      const a = getBus().getAdapter(adapterId)
      return a ? toInfo(a) : null
    },
    getA2UICapabilityMatrix: (adapterId) => getBus().getAdapterA2UICapability(adapterId),
    getSkillCapabilities: (adapterId) => getBus().getAdapterSkillCapabilities(adapterId),
    listInstances: async () => (await listAdapterInstances()).map(toInstanceInfo),
    getInstance: async (id) => {
      const row = await getAdapterInstance(id)
      return row ? toInstanceInfo(row) : null
    },
    getRuntimeState: (adapterId) => getAdapterRuntimeStateSnapshot(adapterId),
    fetchHistory: (adapterId, conversationKey, opts) =>
      getBus().fetchHistoryAll(adapterId, conversationKey, opts),
    onInbound: (handler) => getBus().subscribeInbound(handler),
    onCallback: (handler) => getBus().subscribeCallback(handler),

    // ── outbound mutations ───────────────────────────────────────────────────
    send: (adapterId, req) => getBus().sendOutbound(adapterId, req),
    sendText: (adapterId, conversationRef, text) =>
      getBus().sendOutbound(adapterId, {
        conversationRef,
        segments: [{ type: "text", text }],
        metadata: { idempotencyKey: newIdempotencyKey() },
      }),
    editMessage: (adapterId, messageId, patch) =>
      getBus().editOutbound(adapterId, messageId, patch),
    deleteMessage: (adapterId, messageId) => getBus().deleteOutbound(adapterId, messageId),
    setTyping: (adapterId, conversationKey, on) =>
      getBus().setTypingOutbound(adapterId, conversationKey, on),
    uploadFile: (adapterId, file) => getBus().uploadFileOutbound(adapterId, file),
    streamReply: (adapterId, req) => getBus().streamReplyOutbound(adapterId, req),

    // ── a2ui builder (pure) ──────────────────────────────────────────────────
    a2ui: createA2UIBuilder(),
    newIdempotencyKey: () => newIdempotencyKey(),

    // ── instance management ──────────────────────────────────────────────────
    createInstance: async (input) => toInstanceInfo(await createAdapterInstance(input)),
    updateInstance: (id, patch) => updateAdapterInstance(id, patch),
    setInstanceEnabled: (id, enabled) => updateAdapterInstance(id, { enabled }),
    deleteInstance: (id) => deleteAdapterInstance(id),
  }

  return createGuardedAPI(pluginId, api, {
    listAdapters: "connectors:read",
    getAdapter: "connectors:read",
    getA2UICapabilityMatrix: "connectors:read",
    getSkillCapabilities: "connectors:read",
    listInstances: "connectors:read",
    getInstance: "connectors:read",
    getRuntimeState: "connectors:read",
    fetchHistory: "connectors:read",
    onInbound: "connectors:read",
    onCallback: "connectors:read",
    send: "connectors:send",
    sendText: "connectors:send",
    editMessage: "connectors:send",
    deleteMessage: "connectors:send",
    setTyping: "connectors:send",
    uploadFile: "connectors:send",
    streamReply: "connectors:send",
    createInstance: "connectors:manage",
    updateInstance: "connectors:manage",
    setInstanceEnabled: "connectors:manage",
    deleteInstance: "connectors:manage",
  })
}

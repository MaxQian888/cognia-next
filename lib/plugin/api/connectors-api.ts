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
 *    delete the user's adapter instances (changes live delivery routing),
 *    replace dispatch-rule tables, pre-mint conversations, and drive the
 *    capability-gated chat-management surface (create/update chats, manage
 *    members, resolve contacts — the last one deliberately confirm-tier
 *    because directory lookups expose personal data).
 *
 * Multi-bot surfaces: session bindings (`findSessionByConversation` /
 * `listSiblingConversations`), running-adapter enumeration, dispatch-rule
 * read/dry-run/replace, at-gate dry-run, and a durable queue-backed
 * `enqueueSend` (PII-gated, `source: "plugin"`).
 *
 * All observers (`onInbound`/`onCallback`) are passive read-only taps; they
 * run before the authoritative routing/handler and cannot alter it.
 */

import { getBus } from "@/lib/connectors/bus"
import { getDb } from "@/lib/db/schema"
import { newIdempotencyKey } from "@/types/connectors/outbound"
import { createGuardedAPI } from "@/lib/plugin/security/permission-guard"
import {
  findSessionByConversationKey,
  listSessionsByConversationKey,
  listSiblingConversations,
} from "@/lib/connectors/session-bindings"
import { bootstrapConversation } from "@/lib/connectors/conversation-bootstrap"
import { getRunningAdapter, listRunningAdapters } from "@/lib/connectors/lifecycle"
import { matchDispatchRule } from "@/lib/connectors/dispatch-rules"
import { shouldRespondToMessage } from "@/lib/connectors/at-gate"
import { readForResolution } from "@/lib/db/conversation-overrides"
import { waitForOutboundTerminal } from "@/lib/db/outbound-jobs"
import { requireMethod, withScopeCapture } from "@/lib/skills/built-in/im/_helpers"
import {
  ConnectorDeliveryHeldError,
  ConnectorDeliveryPiiError,
  getConnectorDeliveryGateway,
} from "@/lib/connectors/delivery-gateway"
import { pluginDestination, PluginDestinationError } from "@/lib/connectors/plugin-destination"
import { createA2UIBuilder } from "@/lib/connectors/a2ui-bridge/surface-builder"
import {
  createAdapterInstance,
  updateAdapterInstance,
  getAdapterInstance,
  listAdapterInstances,
} from "@/lib/db/adapter-instances"
import { removeAdapterInstance } from "@/lib/connectors/remove-adapter-instance"
import { getAdapterRuntimeStateSnapshot } from "@/lib/connectors/outbound-runner"
import type { AdapterInstanceRow, OutboundJobRow } from "@/lib/db/connector-types"
import type { ChatSession } from "@cognia/agent-config-types"
import type {
  OutboundRequest,
  OutboundResult,
  PlatformAdapter,
  Capability,
} from "@/types/connectors"
import type {
  PluginAdapterInstanceInfo,
  PluginBoundSessionInfo,
  PluginConnectorAdapterInfo,
  PluginConnectorsAPI,
  PluginOutboundJobStatus,
} from "@cognia/plugin-contract/lib/plugin/api/connectors-api"
export type {
  PluginAdapterInstanceInfo,
  PluginAdapterInstanceInput,
  PluginAdapterInstancePatch,
  PluginBoundSessionInfo,
  PluginConnectorAdapterInfo,
  PluginConnectorAdapterSupport,
  PluginConnectorsAPI,
  PluginOutboundJobInfo,
  PluginOutboundJobStatus,
} from "@cognia/plugin-contract/lib/plugin/api/connectors-api"

export type { PluginConnectorsA2UIBuilder } from "@/lib/connectors/a2ui-bridge/surface-builder"
export type { SiblingConversation } from "@/lib/connectors/session-bindings"
export type { DispatchRuleHit } from "@/lib/connectors/dispatch-rules"
export type { AtGateDecision } from "@/lib/connectors/at-gate"
export type {
  BootstrapConversationInput,
  BootstrapConversationResult,
} from "@/lib/connectors/conversation-bootstrap"

function toJobStatus(row: OutboundJobRow): PluginOutboundJobStatus {
  return {
    jobId: row.id,
    adapterId: row.adapterId,
    conversationKey: row.conversationKey,
    status: row.status,
    nextAttemptAt: row.nextAttemptAt,
    idempotencyKey: row.idempotencyKey,
    attempts: row.attempts,
    ...(row.lastError !== undefined ? { lastError: row.lastError } : {}),
    ...(row.lastErrorCode !== undefined ? { lastErrorCode: row.lastErrorCode } : {}),
    ...(row.platformMessageId !== undefined ? { platformMessageId: row.platformMessageId } : {}),
    ...(row.reroutedToJobId !== undefined ? { reroutedToJobId: row.reroutedToJobId } : {}),
  }
}

function toBoundSessionInfo(s: ChatSession): PluginBoundSessionInfo {
  return {
    sessionId: s.id,
    title: s.title,
    conversationKey: s.platformConversationKey ?? s.platformBinding?.conversationKey ?? "",
    ...(s.characterId ? { characterId: s.characterId } : {}),
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  }
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
  delete copy.outboundRecipients
  return copy as PluginAdapterInstanceInfo
}

/** Load a configured instance row or throw an actionable error. */
async function requireInstance(instanceId: string): Promise<AdapterInstanceRow> {
  const row = await getAdapterInstance(instanceId)
  if (!row) {
    throw new Error(`ctx.connectors: adapter instance ${instanceId} not found`)
  }
  return row
}

/**
 * Resolve a RUNNING, healthy adapter that declares every required
 * chat-management capability. Mirrors the `im.*` skills'
 * `resolveChatCapableAdapter`, minus the session-binding fallback — the
 * plugin always names the adapter explicitly.
 */
function resolveChatAdapter(adapterId: string, requiredCaps: readonly Capability[]) {
  const entry = getRunningAdapter(adapterId)
  if (!entry) {
    throw new Error(
      `ctx.connectors: adapter ${adapterId} is not running — reconnect it from Settings → Connections → Health.`
    )
  }
  const adapter = entry.adapter
  if (adapter.health().state !== "running") {
    throw new Error(
      `ctx.connectors: adapter ${adapterId} is not healthy (${adapter.health().state}).`
    )
  }
  const missing = requiredCaps.filter((cap) => !adapter.meta.capabilities.includes(cap))
  if (missing.length > 0) {
    throw new Error(
      `ctx.connectors: adapter ${adapterId} (${adapter.meta.type}) does not declare the required capabilities: ${missing.join(", ")}.`
    )
  }
  return { adapter, adapterId, platform: adapter.meta.type }
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
    listRunningAdapters: () => listRunningAdapters().map((e) => toInfo(e.adapter)),
    listEnabledInstances: async () =>
      (await listAdapterInstances()).filter((r) => r.enabled).map(toInstanceInfo),
    listInstancesByType: async (type) =>
      (await listAdapterInstances()).filter((r) => r.type === type).map(toInstanceInfo),
    findSessionByConversation: async (conversationKey) => {
      const session = await findSessionByConversationKey(conversationKey)
      return session ? toBoundSessionInfo(session) : null
    },
    listSessionsByConversation: async (conversationKey) =>
      (await listSessionsByConversationKey(conversationKey)).map(toBoundSessionInfo),
    listSiblingConversations: (conversationKey) => listSiblingConversations(conversationKey),
    getDispatchRules: async (instanceId) => (await requireInstance(instanceId)).dispatchRules ?? [],
    previewDispatchRules: async (instanceId, event) =>
      matchDispatchRule((await requireInstance(instanceId)).dispatchRules, event),
    previewAtGate: async (instanceId, event) => {
      const [instance, override] = await Promise.all([
        requireInstance(instanceId),
        readForResolution(event.conversationKey).catch(() => undefined),
      ])
      return shouldRespondToMessage(event, instance, override)
    },
    getOutboundJob: async (jobId) => {
      const row = await getDb().outboundQueue.get(jobId)
      return row ? toJobStatus(row) : null
    },
    waitForDelivery: async (jobId, opts) => {
      const timeoutMs = Math.min(Math.max(opts?.timeoutMs ?? 30_000, 100), 5 * 60_000)
      // Shared event-driven wait (Dexie liveQuery — no polling loop; also
      // used by the `action.connector.send` workflow node). The timeout
      // path resolves with the latest snapshot instead of rejecting so
      // callers can distinguish "still retrying" from "failed terminally"
      // by inspecting `status`.
      const row = await waitForOutboundTerminal(jobId, timeoutMs)
      if (!row) {
        throw new Error(`ctx.connectors.waitForDelivery: unknown job '${jobId}'`)
      }
      return toJobStatus(row)
    },

    // ── outbound mutations ───────────────────────────────────────────────────
    send: (adapterId, req) => legacyDirectSend(pluginId, adapterId, req),
    sendText: (adapterId, conversationRef, text) =>
      legacyDirectSend(pluginId, adapterId, {
        conversationRef,
        segments: [{ type: "text", text }],
        metadata: { idempotencyKey: newIdempotencyKey() },
      }),
    editMessage: (adapterId, messageId, patch) =>
      getBus().editOutbound(adapterId, messageId, patch),
    deleteMessage: (adapterId, messageId) => getBus().deleteOutbound(adapterId, messageId),
    deleteEphemeralCard: (adapterId, messageId) =>
      getBus().deleteEphemeralCard(adapterId, messageId),
    addReaction: (adapterId, messageId, emojiType) =>
      getBus().addReactionOutbound(adapterId, messageId, emojiType),
    removeReaction: (adapterId, messageId, reactionId) =>
      getBus().removeReactionOutbound(adapterId, messageId, reactionId),
    // Planned as a delivery to the target conversation that cannot wait (ADR-0239).
    forwardMessage: (adapterId, input) =>
      getConnectorDeliveryGateway().forward({
        adapterId,
        forward: input,
        source: "plugin",
        authorization: { kind: "plugin", pluginId },
        auditFields: { pluginId },
      }),
    pinMessage: (adapterId, conversationKey, messageId) =>
      getBus().pinOutbound(adapterId, conversationKey, messageId),
    unpinMessage: (adapterId, messageId) => getBus().unpinOutbound(adapterId, messageId),
    sendUrgent: (adapterId, messageId, userIds, via) =>
      getBus().sendUrgentOutbound(adapterId, messageId, userIds, via),
    getReadReceipt: (adapterId, messageId) => getBus().getReadReceiptOutbound(adapterId, messageId),
    setTyping: (adapterId, conversationKey, on) =>
      getBus().setTypingOutbound(adapterId, conversationKey, on),
    uploadFile: (adapterId, file) => getBus().uploadFileOutbound(adapterId, file),
    // A stream can be neither planned nor drafted: under enforcement it
    // reports "no streaming", and the plugin falls back to a governed send.
    streamReply: async (adapterId, req) =>
      (await getConnectorDeliveryGateway().allowsUnplannedStream())
        ? getBus().streamReplyOutbound(adapterId, req)
        : false,
    enqueueSend: async (adapterId, conversationKey, req, opts) => {
      const result = await getConnectorDeliveryGateway().enqueueAuthorized({
        adapterId,
        conversationKey,
        // Sent where the host stored this conversation, never to a reference
        // of the plugin's own (ADR-0239).
        request: await pluginDestination(adapterId, conversationKey, req),
        source: "plugin",
        // Covered by one of this plugin's running, authorized tool calls, or
        // planned as the plugin's own unattended send, with the list of the
        // handler Bot run it names (ADR-0239).
        authorization: {
          kind: "plugin",
          pluginId,
          ...(opts?.botRunId ? { botRunId: opts.botRunId } : {}),
        },
        ...(opts?.nextAttemptAt !== undefined ? { nextAttemptAt: opts.nextAttemptAt } : {}),
      })
      if (result.kind === "drafted") throw new ConnectorDeliveryHeldError(result.draft.id)
      const row = result.job
      return {
        jobId: row.id,
        adapterId: row.adapterId,
        conversationKey: row.conversationKey,
        status: row.status,
        nextAttemptAt: row.nextAttemptAt,
        idempotencyKey: row.idempotencyKey,
      }
    },

    // ── a2ui builder (pure) ──────────────────────────────────────────────────
    a2ui: createA2UIBuilder(),
    newIdempotencyKey: () => newIdempotencyKey(),

    // ── instance management ──────────────────────────────────────────────────
    createInstance: async (input) => toInstanceInfo(await createAdapterInstance(input)),
    updateInstance: (id, patch) => updateAdapterInstance(id, patch),
    setInstanceEnabled: (id, enabled) => updateAdapterInstance(id, { enabled }),
    deleteInstance: async (id) => {
      // Resolve the row so the keyring purge knows which accounts to drop;
      // an unknown id still runs the delete (idempotent no-op) so a plugin
      // retrying a removal never errors on the second attempt.
      const row = await getAdapterInstance(id)
      await removeAdapterInstance(row ?? { id })
    },
    setDispatchRules: async (instanceId, rules) => {
      await requireInstance(instanceId)
      await updateAdapterInstance(instanceId, { dispatchRules: rules })
    },
    bootstrapConversation: (input) =>
      bootstrapConversation({ ...input, source: `plugin:${pluginId}` }),

    // ── chat management (capability-gated, running adapter required) ────────
    createChat: async (adapterId, input) => {
      const resolved = resolveChatAdapter(adapterId, ["chat.create"])
      const fn = requireMethod(resolved, "createChat")
      return withScopeCapture(adapterId, () => fn.call(resolved.adapter, input))
    },
    updateChat: async (adapterId, input) => {
      const resolved = resolveChatAdapter(adapterId, ["chat.update"])
      const fn = requireMethod(resolved, "updateChat")
      return withScopeCapture(adapterId, () => fn.call(resolved.adapter, input))
    },
    addChatMembers: async (adapterId, input) => {
      const resolved = resolveChatAdapter(adapterId, ["chat.members"])
      const fn = requireMethod(resolved, "addChatMembers")
      return withScopeCapture(adapterId, () => fn.call(resolved.adapter, input))
    },
    removeChatMembers: async (adapterId, input) => {
      const resolved = resolveChatAdapter(adapterId, ["chat.members"])
      const fn = requireMethod(resolved, "removeChatMembers")
      return withScopeCapture(adapterId, () => fn.call(resolved.adapter, input))
    },
    resolveContacts: async (adapterId, input) => {
      const resolved = resolveChatAdapter(adapterId, ["contact.resolve"])
      const fn = requireMethod(resolved, "resolveContacts")
      return withScopeCapture(adapterId, () => fn.call(resolved.adapter, input))
    },
  }

  return createGuardedAPI(
    pluginId,
    api,
    {
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
      listRunningAdapters: "connectors:read",
      listEnabledInstances: "connectors:read",
      listInstancesByType: "connectors:read",
      findSessionByConversation: "connectors:read",
      listSessionsByConversation: "connectors:read",
      listSiblingConversations: "connectors:read",
      getDispatchRules: "connectors:read",
      previewDispatchRules: "connectors:read",
      previewAtGate: "connectors:read",
      getOutboundJob: "connectors:read",
      waitForDelivery: "connectors:read",
      getReadReceipt: "connectors:read",
      send: "connectors:send",
      sendText: "connectors:send",
      editMessage: "connectors:send",
      deleteMessage: "connectors:send",
      deleteEphemeralCard: "connectors:send",
      addReaction: "connectors:send",
      removeReaction: "connectors:send",
      forwardMessage: "connectors:send",
      pinMessage: "connectors:send",
      unpinMessage: "connectors:send",
      sendUrgent: "connectors:send",
      setTyping: "connectors:send",
      uploadFile: "connectors:send",
      streamReply: "connectors:send",
      enqueueSend: "connectors:send",
      createInstance: "connectors:manage",
      updateInstance: "connectors:manage",
      setInstanceEnabled: "connectors:manage",
      deleteInstance: "connectors:manage",
      setDispatchRules: "connectors:manage",
      bootstrapConversation: "connectors:manage",
      createChat: "connectors:manage",
      updateChat: "connectors:manage",
      addChatMembers: "connectors:manage",
      removeChatMembers: "connectors:manage",
      resolveContacts: "connectors:manage",
    },
    {
      // Pure, ungated helper (mints a client-side idempotency key). The `a2ui`
      // builder is a non-function property and passes through unchanged.
      unguarded: ["newIdempotencyKey"],
    }
  )
}

/** A refusal as the failed result the direct calls return. */
function refusedResult(error: { code: string; message: string }): OutboundResult {
  return { ok: false, error: { code: error.code, message: error.message, retryable: false } }
}

/**
 * The deprecated direct `send` / `sendText`: planned by the outbound policy
 * and sent at once (ADR-0239). A request whose delivery target names its
 * conversation goes to the target the host stored for it; one that names only
 * a platform reference has a recipient nobody can check, so under
 * enforcement it is refused, and in shadow mode it is sent as before and
 * recorded.
 */
async function legacyDirectSend(
  pluginId: string,
  adapterId: string,
  request: OutboundRequest
): Promise<OutboundResult> {
  console.warn(
    `[connectors-api] plugin ${pluginId} used deprecated direct send; migrate to ctx.connectors.enqueueSend`
  )
  const conversationKey = request.deliveryTarget?.address.conversationKey
  let addressed = request
  if (conversationKey) {
    try {
      addressed = await pluginDestination(adapterId, conversationKey, request)
    } catch (error) {
      if (error instanceof PluginDestinationError) return refusedResult(error)
      throw error
    }
  }
  try {
    return await getConnectorDeliveryGateway().sendNow(
      {
        adapterId,
        ...(conversationKey ? { conversationKey } : {}),
        segments: addressed.segments,
        idempotencyKey: addressed.metadata.idempotencyKey,
        source: "plugin",
        authorization: { kind: "plugin", pluginId },
        auditKind: "delivery.legacy_direct",
        auditFields: {
          pluginId,
          reason: "plugin_compatibility_waiver",
          migrationTarget: "ctx.connectors.enqueueSend",
        },
      },
      () => getBus().sendOutbound(adapterId, addressed)
    )
  } catch (error) {
    if (error instanceof ConnectorDeliveryPiiError) return refusedResult(error)
    throw error
  }
}

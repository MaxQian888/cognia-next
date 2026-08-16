/**
 * Brain-side subscriber for the companion's Lark intent bridge
 * (plan 2026-07-24 P3.2/P3.3).
 *
 * The Rust front door publishes `connectors://lark-intent` frames when a
 * browser hits the public entry surface:
 *
 *   - `entry_consumed`   — a single-use entry token was redeemed; mark the
 *                          Dexie ledger row (audit only, enforcement already
 *                          happened in Rust).
 *   - `resolve_surface`  — a Chat Tab / group-menu open needs authorization:
 *                          verify the logged-in user is a MEMBER of the chat
 *                          via the Lark members API, then answer the pending
 *                          intent with the conversationKey (or a deny code).
 *   - `import_messages`  — message-shortcut import (plan P5.1): delegate to
 *                          `adapters/lark/message-import.ts` (flag + principal
 *                          + membership + per-message verification) and answer
 *                          with the produced sessionId/conversationKey.
 *   - `plus_create`      — `+`-menu new-task intent (plan P5.2): delegate to
 *                          `adapters/lark/plus-create.ts`.
 *   - `principal_admin`  — operator registry mutation from `cognia lark …`
 *                          (plan P1.1). Authenticated at the Rust front door
 *                          by the device/service JWT tier; the brain owns the
 *                          account database, so it performs the write.
 *
 * Registered by the headless connector runtime; a desktop install without a
 * companion listener simply never receives these frames.
 */

import { buildConversationKey } from "@/types/connectors/event"
import { transport } from "@/lib/tauri"
import { connectorsKeyringGet } from "@/lib/connectors/tauri/commands"
import { markEntryContextConsumed, touchWebSession } from "@/lib/db/lark-entry"
import { appendAudit } from "@/lib/connectors/audit"
import { larkTenantRequest, type LarkCredentials } from "@/lib/connectors/adapters/lark/http"
import { importLarkMessages } from "@/lib/connectors/adapters/lark/message-import"
import { handlePlusCreate } from "@/lib/connectors/adapters/lark/plus-create"
import { runPrincipalAdminIntent } from "@/lib/connectors/principal/admin-intent"
import { hashOpenId, resolveConnectorPrincipal } from "@/lib/connectors/principal/resolve"
import { getAdapterInstance } from "@/lib/db/adapter-instances"

export const LARK_INTENT_TOPIC = "connectors://lark-intent"

const MEMBER_PAGE_SIZE = 100
const MEMBER_PAGE_LIMIT = 50

export interface LarkIntentFrame {
  kind?: string
  requestId?: string
  adapterId?: string
  chatId?: string
  jti?: string
  entryType?: string
  surface?: string
  messageIds?: string[]
  triggerId?: string
  verifiedIdentity?: { openId?: string; tenantKey?: string; appId?: string }
  /**
   * Ledger projection of the web session that authorized this intent —
   * `idHash` is a SHA-256 prefix of the session jti, never the jti itself.
   * Absent on `entry_consumed` (no session involved) and on frames from a
   * companion older than the ledger wiring, which is why every consumer
   * treats it as optional rather than malformed.
   */
  session?: { idHash?: string; issuedAt?: number; expiresAt?: number }
  /** `principal_admin` only. */
  op?: string
  code?: string
  principalId?: string
  status?: string
  cogniaUserId?: string
  /** `principal_admin` / `oauth-begin` only. */
  redirectUri?: string
}

export interface LarkIntentDependencies {
  call: <T>(name: string, args?: Record<string, unknown>) => Promise<T>
  keyringGet: (adapterId: string, credential: string) => Promise<string | null>
  tenantRequest: typeof larkTenantRequest
  markConsumed: typeof markEntryContextConsumed
  touchSession: typeof touchWebSession
  hashIdentity: typeof hashOpenId
  audit: typeof appendAudit
  importMessages: typeof importLarkMessages
  plusCreate: typeof handlePlusCreate
  runAdmin: typeof runPrincipalAdminIntent
  resolvePrincipal: typeof resolveConnectorPrincipal
  getAdapter: typeof getAdapterInstance
}

async function credsFor(
  deps: LarkIntentDependencies,
  adapterId: string
): Promise<LarkCredentials | null> {
  const [appId, appSecret] = await Promise.all([
    deps.keyringGet(adapterId, "appId"),
    deps.keyringGet(adapterId, "appSecret"),
  ])
  return appId && appSecret ? { appId, appSecret } : null
}

interface MemberListPage {
  data?: {
    items?: Array<{ member_id?: string }>
    has_more?: boolean
    page_token?: string
  }
}

/** Paginated contains-check over the chat member list. */
export async function isChatMember(
  deps: LarkIntentDependencies,
  adapterId: string,
  chatId: string,
  openId: string
): Promise<boolean> {
  const creds = await credsFor(deps, adapterId)
  if (!creds) throw new Error("lark credentials unavailable")
  let pageToken: string | undefined
  for (let page = 0; page < MEMBER_PAGE_LIMIT; page += 1) {
    const query = new URLSearchParams({
      member_id_type: "open_id",
      page_size: String(MEMBER_PAGE_SIZE),
      ...(pageToken ? { page_token: pageToken } : {}),
    })
    const resp = (await deps.tenantRequest(
      creds,
      "GET",
      `/im/v1/chats/${encodeURIComponent(chatId)}/members?${query.toString()}`
    )) as MemberListPage
    const items = resp.data?.items ?? []
    if (items.some((item) => item.member_id === openId)) return true
    if (!resp.data?.has_more || !resp.data.page_token) return false
    pageToken = resp.data.page_token
  }
  return false
}

/**
 * Record a sighting of the web session that authorized this intent.
 *
 * Enforcement stays in the companion (HMAC + TTL); this is the durable ops
 * view — which identities hold a live session, on which tenant, and when they
 * were last seen — and it is the only place that information is queryable
 * after the fact, since the companion keeps sessions stateless by design.
 *
 * Best-effort on purpose: an intent must never fail because its audit row
 * could not be written. A companion that does not send `session` (older
 * build, or `entry_consumed`, which carries none) simply records nothing.
 */
async function recordSessionSighting(
  frame: LarkIntentFrame,
  deps: LarkIntentDependencies,
  principalId?: string
): Promise<void> {
  const idHash = frame.session?.idHash
  const openId = frame.verifiedIdentity?.openId
  if (!idHash || !openId || !frame.adapterId) return
  try {
    await deps.touchSession({
      jtiHash: idHash,
      adapterId: frame.adapterId,
      openIdHash: await deps.hashIdentity(openId),
      tenantKey: frame.verifiedIdentity?.tenantKey ?? "",
      appId: frame.verifiedIdentity?.appId ?? "",
      principalId,
      issuedAt: frame.session?.issuedAt ?? Date.now(),
      expiresAt: frame.session?.expiresAt ?? Date.now(),
    })
  } catch {
    // Ledger write failures are not the intent's problem.
  }
}

/** Handle one intent frame. Exported for tests. */
export async function handleLarkIntentFrame(
  frame: LarkIntentFrame,
  deps: LarkIntentDependencies
): Promise<void> {
  if (frame.kind === "entry_consumed") {
    if (frame.jti) await deps.markConsumed(frame.jti)
    if (frame.adapterId) {
      await deps
        .audit({
          adapterId: frame.adapterId,
          kind: "entry.consumed",
          at: Date.now(),
          fields: { jti: frame.jti, entryType: frame.entryType },
        })
        .catch(() => undefined)
    }
    return
  }

  if (frame.kind === "resolve_surface") {
    const { requestId, adapterId, chatId } = frame
    const openId = frame.verifiedIdentity?.openId
    if (!requestId) return
    if (!adapterId || !chatId || !openId) {
      await deps.call("lark_result_complete", { requestId, error: "intent_malformed" })
      return
    }
    try {
      // Principal BEFORE membership. Chat membership says "you are in this
      // room"; it says nothing about whether Cognia still serves you. Without
      // this a disabled or unlinked principal — or one belonging to another
      // account entirely — could still open a Chat Tab and land in the
      // conversation, because the import and `+` paths were the only ones
      // that resolved the principal.
      const resolution = await deps.resolvePrincipal({
        platform: "lark",
        adapterRow: (await deps.getAdapter(adapterId).catch(() => undefined)) ?? { settings: {} },
        remoteUserId: openId,
        identityScope: {
          tenantKey: frame.verifiedIdentity?.tenantKey,
          appId: frame.verifiedIdentity?.appId,
        },
      })
      // Sighting BEFORE the outcome branch: a denied open is exactly the
      // event an operator goes to the ledger to explain.
      await recordSessionSighting(
        frame,
        deps,
        resolution.status === "resolved" ? resolution.principal.id : undefined
      )
      if (resolution.status !== "resolved" && resolution.status !== "legacy") {
        await deps
          .audit({
            adapterId,
            kind: "entry.denied",
            at: Date.now(),
            reason: `principal_${resolution.status}`,
            fields: { chatId, surface: frame.surface },
          })
          .catch(() => undefined)
        await deps.call("lark_result_complete", {
          requestId,
          error: `principal_${resolution.status}`,
        })
        return
      }

      const member = await isChatMember(deps, adapterId, chatId, openId)
      if (!member) {
        await deps
          .audit({
            adapterId,
            kind: "entry.denied",
            at: Date.now(),
            reason: "membership_denied",
            fields: { chatId, surface: frame.surface },
          })
          .catch(() => undefined)
        await deps.call("lark_result_complete", { requestId, error: "membership_denied" })
        return
      }
      const conversationKey = buildConversationKey("lark", adapterId, chatId)
      await deps.call("lark_result_complete", {
        requestId,
        result: { conversationKey, surface: frame.surface },
      })
    } catch {
      await deps
        .call("lark_result_complete", { requestId, error: "membership_check_failed" })
        .catch(() => undefined)
    }
    return
  }

  if (frame.kind === "principal_admin") {
    const { requestId, adapterId, op } = frame
    if (!requestId) return
    if (!adapterId || !op) {
      await deps.call("lark_result_complete", { requestId, error: "intent_malformed" })
      return
    }
    try {
      const outcome = await deps.runAdmin({
        adapterId,
        op,
        code: frame.code,
        principalId: frame.principalId,
        status: frame.status,
        cogniaUserId: frame.cogniaUserId,
        redirectUri: frame.redirectUri,
      })
      await deps.call(
        "lark_result_complete",
        outcome.ok ? { requestId, result: outcome.result } : { requestId, error: outcome.error }
      )
    } catch {
      await deps
        .call("lark_result_complete", { requestId, error: "intent_failed" })
        .catch(() => undefined)
    }
    return
  }

  if (frame.kind === "import_messages" || frame.kind === "plus_create") {
    const { requestId, adapterId } = frame
    const openId = frame.verifiedIdentity?.openId
    if (!requestId) return
    if (!adapterId || !openId) {
      await deps.call("lark_result_complete", { requestId, error: "intent_malformed" })
      return
    }
    const verifiedIdentity = {
      openId,
      tenantKey: frame.verifiedIdentity?.tenantKey,
      appId: frame.verifiedIdentity?.appId,
    }
    await deps
      .audit({
        adapterId,
        kind: "sso.session_seen",
        at: Date.now(),
        fields: { tenantKey: verifiedIdentity.tenantKey, intent: frame.kind },
      })
      .catch(() => undefined)
    // The principal is resolved inside importMessages / plusCreate, so the
    // row lands without one; `touchWebSession` preserves whatever a later
    // resolve_surface sighting attaches.
    await recordSessionSighting(frame, deps)
    const isMember = (memberAdapterId: string, chatId: string, memberOpenId: string) =>
      isChatMember(deps, memberAdapterId, chatId, memberOpenId)
    try {
      if (frame.kind === "import_messages") {
        if (!frame.chatId || !Array.isArray(frame.messageIds)) {
          await deps.call("lark_result_complete", { requestId, error: "intent_malformed" })
          return
        }
        const outcome = await deps.importMessages(
          {
            adapterId,
            chatId: frame.chatId,
            messageIds: frame.messageIds,
            verifiedIdentity,
            triggerId: frame.triggerId,
          },
          { isMember, keyringGet: deps.keyringGet, tenantRequest: deps.tenantRequest }
        )
        await deps.call(
          "lark_result_complete",
          outcome.ok
            ? {
                requestId,
                result: {
                  conversationKey: outcome.conversationKey,
                  sessionId: outcome.sessionId,
                  imported: outcome.imported,
                  skipped: outcome.skipped,
                  replay: outcome.replay,
                },
              }
            : { requestId, error: outcome.error }
        )
        return
      }
      const outcome = await deps.plusCreate(
        { adapterId, chatId: frame.chatId, verifiedIdentity },
        { isMember }
      )
      await deps.call(
        "lark_result_complete",
        outcome.ok
          ? {
              requestId,
              result: { conversationKey: outcome.conversationKey, sessionId: outcome.sessionId },
            }
          : { requestId, error: outcome.error }
      )
    } catch {
      await deps
        .call("lark_result_complete", { requestId, error: "intent_failed" })
        .catch(() => undefined)
    }
  }
}

export type LarkIntentListen = (
  topic: string,
  handler: (event: { payload: unknown }) => void
) => Promise<unknown>

/**
 * Subscribe to the intent topic. Returns a disposer. `listen` mirrors the
 * connector runtime's Tauri-shaped listen seam.
 */
export function installLarkIntentHandler(
  listen: LarkIntentListen,
  overrides: Partial<LarkIntentDependencies> = {}
): () => void {
  const deps: LarkIntentDependencies = {
    call: transport.call,
    keyringGet: connectorsKeyringGet,
    tenantRequest: larkTenantRequest,
    markConsumed: markEntryContextConsumed,
    touchSession: touchWebSession,
    hashIdentity: hashOpenId,
    audit: appendAudit,
    importMessages: importLarkMessages,
    plusCreate: handlePlusCreate,
    runAdmin: runPrincipalAdminIntent,
    resolvePrincipal: resolveConnectorPrincipal,
    getAdapter: getAdapterInstance,
    ...overrides,
  }
  let disposed = false
  let unlisten: (() => void) | undefined
  void listen(LARK_INTENT_TOPIC, (event) => {
    void handleLarkIntentFrame((event.payload ?? {}) as LarkIntentFrame, deps).catch(
      () => undefined
    )
  }).then((dispose) => {
    if (typeof dispose === "function") {
      if (disposed) dispose()
      else unlisten = dispose as () => void
    }
  })
  return () => {
    disposed = true
    unlisten?.()
  }
}

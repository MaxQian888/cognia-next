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
 *
 * Registered by the headless connector runtime; a desktop install without a
 * companion listener simply never receives these frames.
 */

import { buildConversationKey } from "@/types/connectors/event"
import { transport } from "@/lib/tauri"
import { connectorsKeyringGet } from "@/lib/connectors/tauri/commands"
import { markEntryContextConsumed } from "@/lib/db/lark-entry"
import { appendAudit } from "@/lib/connectors/audit"
import { larkTenantRequest, type LarkCredentials } from "@/lib/connectors/adapters/lark/http"

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
  verifiedIdentity?: { openId?: string; tenantKey?: string; appId?: string }
}

export interface LarkIntentDependencies {
  call: <T>(name: string, args?: Record<string, unknown>) => Promise<T>
  keyringGet: (adapterId: string, credential: string) => Promise<string | null>
  tenantRequest: typeof larkTenantRequest
  markConsumed: typeof markEntryContextConsumed
  audit: typeof appendAudit
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
    audit: appendAudit,
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

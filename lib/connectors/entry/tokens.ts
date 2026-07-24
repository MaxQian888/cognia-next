/**
 * Brain-side minting of Lark entry/surface tokens (plan 2026-07-24 P3.2).
 *
 * Tokens are SIGNED by the Rust companion (`lark_entry_issue` RPC, service
 * scope) — the signing secret never reaches JS. This module adds the durable
 * ledger write so operators can audit which links exist and when they were
 * consumed.
 */

import { transport } from "@/lib/tauri"
import { recordEntryContext } from "@/lib/db/lark-entry"

export type RpcCall = <T>(name: string, args?: Record<string, unknown>) => Promise<T>

export interface IssueEntryTokenInput {
  adapterId: string
  principalId: string
  accountId: string
  openId: string
  tenantKey: string
  appId: string
  entryType: string
  conversationKey: string
  sessionId?: string
}

export interface IssuedEntryToken {
  token: string
  jti: string
  expiresAt: number
}

export async function issueEntryToken(
  input: IssueEntryTokenInput,
  overrides: { call?: RpcCall } = {}
): Promise<IssuedEntryToken> {
  const call = overrides.call ?? transport.call
  const issued = await call<IssuedEntryToken>("lark_entry_issue", {
    kind: "entry",
    adapterId: input.adapterId,
    principalId: input.principalId,
    accountId: input.accountId,
    openId: input.openId,
    tenantKey: input.tenantKey,
    appId: input.appId,
    entryType: input.entryType,
    conversationKey: input.conversationKey,
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
  })
  // Ledger is best-effort: a Dexie hiccup must not lose the minted token.
  await recordEntryContext({
    jti: issued.jti,
    adapterId: input.adapterId,
    principalId: input.principalId,
    accountId: input.accountId,
    entryType: input.entryType,
    conversationKey: input.conversationKey,
    sessionId: input.sessionId,
    expiresAt: issued.expiresAt,
  }).catch(() => undefined)
  return issued
}

export interface IssueSurfaceTokenInput {
  adapterId: string
  tenantKey: string
  appId: string
  chatId: string
  urlVersion: number
  surface: "chat_tab" | "group_menu"
}

export async function issueSurfaceToken(
  input: IssueSurfaceTokenInput,
  overrides: { call?: RpcCall } = {}
): Promise<string> {
  const call = overrides.call ?? transport.call
  const issued = await call<{ token: string }>("lark_entry_issue", {
    kind: "surface",
    adapterId: input.adapterId,
    tenantKey: input.tenantKey,
    appId: input.appId,
    chatId: input.chatId,
    urlVersion: input.urlVersion,
    surface: input.surface,
  })
  return issued.token
}

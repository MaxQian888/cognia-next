/**
 * Who an outbound tool call delivers to (ADR-0239).
 *
 * The outbound policy engine authorizes recipients, not tools, so every call
 * to a tool in `OUTBOUND_TOOL_IDS` is reduced to a list of targets here: a
 * channel and a normalized recipient. The fence and instruction grants match
 * on {@link outboundFingerprint}, which hashes the channel and recipient and
 * nothing else, so rewording a message or switching to another send tool for
 * the same recipient lands on the same fingerprint.
 *
 * Recipients are normalized to the audience, not the address form:
 *
 * - A conversation drops its thread id. A thread is a view of the same chat
 *   and reaches the same members, so a denial of one thread fences the chat.
 * - A person is `<adapterId>:<memberId>`. The IM tools take the platform's own
 *   member ids, which are scoped to a bot (a Lark open_id differs per app),
 *   the same per-adapter scoping the trigger user-allowlist uses.
 * - A mail address is lowercased with any display name stripped.
 *
 * A call whose recipient cannot be named yields one `unknown` target for the
 * tool. The engine never allows an `unknown` or `public` target implicitly,
 * so a malformed key, a missing argument or an unrecognised third-party tool
 * shape fails towards asking, never towards sending.
 *
 * Pure: reads only its arguments. The recipient is personal data and is never
 * persisted; receipts store {@link toReviewTarget} (channel + fingerprint).
 */

import { sha256Hex } from "@cognia/agent"
import type { ActionReviewTarget } from "@cognia/agent-config-types/action-review"

import { isOutboundToolId, normalizeToolId } from "@/lib/policy/risk/outbound-tools"
import { parseConversationKey } from "@/types/connectors/event"

/**
 * - `conversation`: an existing chat, by conversation key without its thread.
 * - `person`: a platform member, as when a new chat is created around them.
 * - `mail`: an email address.
 * - `public`: anyone who gets the link (a published Site, a public share).
 *   There is no recipient to authorize, so it is granted per call.
 * - `unknown`: the call's recipient could not be named.
 */
export type OutboundTargetKind = "conversation" | "person" | "mail" | "public" | "unknown"

export interface OutboundTarget {
  kind: OutboundTargetKind
  /** The connector adapter id, `mail`, or `tool:<name>` for tool-level targets. */
  channel: string
  /** Normalized recipient, prefixed by kind (`conv:`, `person:`, `mail:`, …). */
  recipient: string
}

export interface OutboundTargetContext {
  /**
   * The bot a tool falls back to when its input names none: the adapter of
   * the conversation the run is bound to. Without it, a person target from
   * `im_create_chat` with no `adapterId` cannot be scoped and is `unknown`.
   */
  defaultAdapterId?: string
}

/** Tools whose output is a public link rather than a delivery to someone. */
const PUBLIC_TOOL_IDS: ReadonlySet<string> = new Set([
  "deploy_site",
  "filespace_share",
  "filespace_enable_webdav",
])

const MAIL_FIELDS = ["to", "cc", "bcc"] as const

function unknownTarget(tool: string): OutboundTarget {
  return { kind: "unknown", channel: `tool:${tool}`, recipient: "*" }
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  return trimmed ? trimmed : undefined
}

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value.map(nonEmptyString).filter((v): v is string => v !== undefined)
}

/**
 * The chat a conversation key reaches, thread dropped. Returns `undefined`
 * for a key `parseConversationKey` rejects.
 */
export function conversationTarget(conversationKey: string): OutboundTarget | undefined {
  let parsed: ReturnType<typeof parseConversationKey>
  try {
    parsed = parseConversationKey(conversationKey.trim())
  } catch {
    return undefined
  }
  if (!parsed.remoteChatId) return undefined
  return {
    kind: "conversation",
    channel: parsed.adapterId,
    recipient: `conv:${parsed.platform}:${parsed.adapterId}:${parsed.remoteChatId}`,
  }
}

/** A platform member reached through one bot. */
export function personTarget(adapterId: string, memberId: string): OutboundTarget | undefined {
  const adapter = adapterId.trim()
  const member = memberId.trim()
  if (!adapter || !member) return undefined
  return { kind: "person", channel: adapter, recipient: `person:${adapter}:${member}` }
}

/**
 * An email address, lowercased. Accepts `a@b.c` and `Name <a@b.c>`; anything
 * without exactly one `@` and a non-empty local part and domain is rejected.
 */
export function mailTarget(address: string): OutboundTarget | undefined {
  const raw = address.trim()
  const bracketed = /<([^<>]*)>\s*$/.exec(raw)
  const candidate = (bracketed ? bracketed[1] : raw).trim().toLowerCase()
  const at = candidate.indexOf("@")
  if (at <= 0 || at !== candidate.lastIndexOf("@") || at === candidate.length - 1) return undefined
  if (/\s/.test(candidate)) return undefined
  return { kind: "mail", channel: "mail", recipient: `mail:${candidate}` }
}

/** A public link published by a tool. */
export function publicTarget(tool: string): OutboundTarget {
  const name = normalizeToolId(tool)
  return { kind: "public", channel: `tool:${name}`, recipient: `public:${name}` }
}

function conversationTargets(keys: readonly string[], tool: string): OutboundTarget[] {
  if (keys.length === 0) return [unknownTarget(tool)]
  return keys.map((key) => conversationTarget(key) ?? unknownTarget(tool))
}

function personTargets(
  memberIds: readonly string[],
  adapterId: string | undefined,
  tool: string
): OutboundTarget[] {
  if (memberIds.length === 0 || !adapterId) return [unknownTarget(tool)]
  return memberIds.map((id) => personTarget(adapterId, id) ?? unknownTarget(tool))
}

function mailTargets(input: Record<string, unknown>, tool: string): OutboundTarget[] {
  const addresses: string[] = []
  for (const field of MAIL_FIELDS) {
    const value = input[field]
    if (typeof value === "string") addresses.push(...value.split(/[,;]/))
    else if (Array.isArray(value)) addresses.push(...(stringList(value) ?? []))
  }
  const named = addresses.map((a) => a.trim()).filter(Boolean)
  if (named.length === 0) return [unknownTarget(tool)]
  return named.map((a) => mailTarget(a) ?? unknownTarget(tool))
}

function dedupe(targets: OutboundTarget[]): OutboundTarget[] {
  const seen = new Set<string>()
  return targets.filter((t) => {
    const key = `${t.channel}|${t.recipient}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/**
 * Every target one tool call delivers to, deduplicated, in input order.
 *
 * Returns `[]` for a tool that is not outbound, and at least one target for
 * one that is. Extraction follows each tool's registered input schema:
 *
 * - `im_broadcast`: every `conversationKeys` entry.
 * - `im_create_chat`: every `memberIds` entry on `adapterId` (or the default).
 * - `im_dispatch_task`: `existingConversationKey` when set, else the members
 *   of the chat it creates.
 * - `team_post_to_chat`, `connectors_send_message`: `conversationKey`.
 * - `send_email`: `to`, `cc` and `bcc`, each a string (comma or semicolon
 *   separated) or a string list.
 * - `connector_send`, `send_message`: generic names a third-party server may
 *   register under any shape; a `conversationKey` argument is used when
 *   present, else the call is `unknown`.
 * - `deploy_site`, `filespace_share`, `filespace_enable_webdav`: `public`.
 */
export function extractOutboundTargets(
  toolName: string,
  input: unknown,
  context: OutboundTargetContext = {}
): OutboundTarget[] {
  if (!isOutboundToolId(toolName)) return []
  const tool = normalizeToolId(toolName)
  if (PUBLIC_TOOL_IDS.has(tool)) return [publicTarget(tool)]

  const args =
    input && typeof input === "object" && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : {}
  const adapterId = nonEmptyString(args.adapterId) ?? nonEmptyString(context.defaultAdapterId)
  const singleKey = nonEmptyString(args.conversationKey)

  switch (tool) {
    case "im_broadcast":
      return dedupe(conversationTargets(stringList(args.conversationKeys) ?? [], tool))
    case "im_create_chat":
      return dedupe(personTargets(stringList(args.memberIds) ?? [], adapterId, tool))
    case "im_dispatch_task": {
      const existing = nonEmptyString(args.existingConversationKey)
      if (existing) return conversationTargets([existing], tool)
      return dedupe(personTargets(stringList(args.memberIds) ?? [], adapterId, tool))
    }
    case "send_email":
      return dedupe(mailTargets(args, tool))
    case "team_post_to_chat":
    case "connectors_send_message":
    case "connector_send":
    case "send_message":
      return conversationTargets(singleKey ? [singleKey] : [], tool)
    default:
      // An id added to `OUTBOUND_TOOL_IDS` without an extractor here. The
      // test pins that every listed id is handled, so this is a backstop.
      return [unknownTarget(tool)]
  }
}

/** `sha256("outbound|<channel>|<recipient>")`, lowercase hex. No message body. */
/**
 * A recipient's own id, without the kind and bot prefixes it is keyed by:
 * what a card shows next to the recipient's kind and bot. Nothing on the host
 * records chat or member names, so this is the most a card can say.
 */
export function outboundRecipientId(target: Pick<OutboundTarget, "kind" | "recipient">): string {
  switch (target.kind) {
    case "conversation":
      return target.recipient.replace(/^conv:[^:]+:[^:]+:/, "")
    case "person":
      return target.recipient.replace(/^person:[^:]+:/, "")
    case "mail":
      return target.recipient.replace(/^mail:/, "")
    case "public":
      return target.recipient.replace(/^public:/, "")
    case "unknown":
      return target.recipient
  }
}

export function outboundFingerprint(target: Pick<OutboundTarget, "channel" | "recipient">): string {
  return sha256Hex(`outbound|${target.channel}|${target.recipient}`)
}

/** The persisted form of a target: channel and fingerprint, no recipient. */
export function toReviewTarget(target: OutboundTarget): ActionReviewTarget {
  return { channel: target.channel, fingerprint: outboundFingerprint(target) }
}

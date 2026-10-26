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
 * - `repository`: a GitHub repository (phase 2). The PR or issue a write goes
 *   to is its `thread`, which only matches the origin thread.
 * - `site`: the origin a browser submission sends its request to (phase 2).
 * - `public`: anyone who gets the link (a published Site, a public share).
 *   There is no recipient to authorize, so it is granted per call.
 * - `unknown`: the call's recipient could not be named.
 */
export type OutboundTargetKind =
  "conversation" | "person" | "mail" | "repository" | "site" | "public" | "unknown"

export interface OutboundTarget {
  kind: OutboundTargetKind
  /**
   * The connector adapter id; `mail`, `github` or `browser`; or `tool:<name>`
   * for tool-level targets.
   */
  channel: string
  /** Normalized recipient, prefixed by kind (`conv:`, `person:`, `mail:`, `github:`, `site:`, …). */
  recipient: string
  /**
   * For a `repository`: the PR or issue number a write goes to. It never
   * widens a grant or a fence, which cover the whole repository; it only lets
   * a write back into the thread the request came from count as a reply to
   * the origin thread ({@link originMatchFingerprint}). Never persisted.
   */
  thread?: string
}

/**
 * The three kinds of outbound action, each with its own shadow or enforce
 * mode: messaging (phase 1: connector deliveries, messages, mail, shares),
 * GitHub writes and browser submissions (phase 2).
 */
export type OutboundCategory = "messaging" | "github" | "browser"

export const OUTBOUND_CATEGORIES: readonly OutboundCategory[] = ["messaging", "github", "browser"]

/** The category a target's mode is read from: by kind, else by channel. */
export function outboundCategoryOf(
  target: Pick<OutboundTarget, "kind" | "channel">
): OutboundCategory {
  if (target.kind === "repository" || target.channel === "github") return "github"
  if (target.kind === "site" || target.channel === "browser") return "browser"
  return "messaging"
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

const GITHUB_OWNER = /^[a-z0-9](?:[a-z0-9-]{0,38})$/
const GITHUB_REPO = /^[a-z0-9._-]{1,100}$/
const HOST = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::\d{1,5})?$/

/**
 * A GitHub repository, lowercased (GitHub names are case-insensitive), host
 * `github.com` unless another is named. Accepts `owner/repo`,
 * `host/owner/repo`, `https://host/owner/repo[.git][/…]` and
 * `git@host:owner/repo[.git]`. `thread` is a PR or issue number. Returns
 * `undefined` for anything else.
 */
export function repositoryTarget(
  repository: string,
  thread?: string | number
): OutboundTarget | undefined {
  const input = repository.trim().toLowerCase()
  if (!input) return undefined
  let host = "github.com"
  let path = input
  let fromUrl = false
  const ssh = /^[a-z0-9._-]+@([^:/]+):(.+)$/.exec(input)
  if (ssh) {
    host = ssh[1]
    path = ssh[2]
  } else if (/^[a-z][a-z0-9+.-]*:\/\//.test(input)) {
    let url: URL
    try {
      url = new URL(input)
    } catch {
      return undefined
    }
    if (url.protocol !== "https:" && url.protocol !== "http:" && url.protocol !== "ssh:") {
      return undefined
    }
    host = url.host
    path = url.pathname
    fromUrl = true
  }
  const parts = path.split("/").filter(Boolean)
  // `host/owner/repo` names its host; `owner/repo` cannot start with a dotted name.
  if (!ssh && !fromUrl && parts.length === 3 && parts[0].includes(".")) host = parts.shift()!
  // A URL may continue into the repository (`/pull/12`); a bare name may not.
  if (parts.length < 2 || (parts.length > 2 && !fromUrl)) return undefined
  const owner = parts[0]
  const repo = parts[1].replace(/\.git$/, "")
  host = host.replace(/^www\./, "")
  if (!HOST.test(host) || !GITHUB_OWNER.test(owner) || !GITHUB_REPO.test(repo)) return undefined
  if (repo === "." || repo === "..") return undefined
  const number = thread === undefined ? undefined : String(thread).trim().replace(/^#/, "")
  if (number !== undefined && !/^[1-9]\d{0,9}$/.test(number)) return undefined
  return {
    kind: "repository",
    channel: "github",
    recipient: `github:${host}/${owner}/${repo}`,
    ...(number ? { thread: number } : {}),
  }
}

/** A PR or issue number as a thread: a positive integer, or its decimal string. */
export function threadNumber(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return String(value)
  if (typeof value === "string" && /^[1-9]\d*$/.test(value.trim())) return value.trim()
  return undefined
}

/**
 * A bare `owner/repo` on `host` (an account's web host, `githubWebHost`); a
 * value that already names its host, or a URL, is read as is.
 */
export function repositoryOnHost(
  value: string,
  host: string | undefined,
  thread?: string | number
): OutboundTarget | undefined {
  const bare = /^[^/:@\s]+\/[^/:@\s]+$/.test(value.trim())
  return repositoryTarget(
    bare && host && host !== "github.com" ? `https://${host}/${value.trim()}` : value,
    thread
  )
}

/**
 * A GitHub write whose repository could not be named (a `gh` command outside
 * any checkout, `gh api graphql`, a gist). It is never granted, so it always
 * reaches a person, and it is held to the GitHub category's mode.
 */
export function unknownGithubTarget(): OutboundTarget {
  return { kind: "unknown", channel: "github", recipient: "*" }
}

/**
 * A browser submission whose site could not be named (a `data:` or extension
 * page): held to the browser category's mode, and only ever allowed per call.
 */
export function unknownSiteTarget(): OutboundTarget {
  return { kind: "unknown", channel: "browser", recipient: "*" }
}

/**
 * The origin a browser submission sends to: `scheme://host[:port]` of an
 * `http(s)` URL, as `URL` normalizes it (lowercased host, punycode, default
 * port dropped). Returns `undefined` for any other scheme or an opaque origin.
 */
export function siteTarget(url: string): OutboundTarget | undefined {
  let parsed: URL
  try {
    parsed = new URL(url.trim())
  } catch {
    return undefined
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return undefined
  if (!parsed.host || parsed.origin === "null") return undefined
  return { kind: "site", channel: "browser", recipient: `site:${parsed.origin}` }
}

/**
 * The fingerprint an origin thread is matched on. A conversation matches as
 * itself. A repository matches only through its thread: answering on the PR
 * the request came from is a reply, while another PR of the same repository
 * is not. Anything else, or a repository with no thread, matches nothing.
 */
export function originMatchFingerprint(target: OutboundTarget): string | undefined {
  if (target.kind === "conversation") return outboundFingerprint(target)
  if (target.kind === "repository" && target.thread) {
    return outboundFingerprint({
      channel: target.channel,
      recipient: `${target.recipient.replace(/^github:/, "github-thread:")}#${target.thread}`,
    })
  }
  return undefined
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
    case "repository":
      return target.recipient.replace(/^github:(?:github\.com\/)?/, "")
    case "site":
      return target.recipient.replace(/^site:/, "")
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

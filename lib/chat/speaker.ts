/**
 * Who said this message.
 *
 * # Why this exists
 *
 * Three surfaces in this repository put a multi-participant conversation in
 * front of a model, and none of them told it who was talking:
 *
 *   - **IM groups** (`lib/connectors/runtime.ts:inboundEventToSendContent`)
 *     mapped segment bodies only. The sender lives in
 *     `metadata.platformMessage.sender`, which the model never reads. A
 *     five-person Lark group arrived as one undifferentiated speaker.
 *   - **Shared sessions** (`lib/collab/`) carry the richest author model in
 *     the tree (`AuthorRef`), and it was used for rendering only.
 *   - **Character teams** (`hooks/chat/use-team-chat.ts:buildTranscript`)
 *     wrote every human turn as `User:`, so two people in one room collapsed
 *     into one.
 *
 * Fixing those separately would have produced three speaker concepts that do
 * not know about each other. This module is the one resolver all three use.
 *
 * # The safety gate is load-bearing, not decoration
 *
 * `lib/connectors/ai-loop/safe-send-prompt.ts` walks EVERY text block of an
 * outbound `SendContent` through `hasNoLeakingPii` and aborts the whole turn
 * with a `pii_blocked` audit row if any block fails. A display name is
 * attacker-supplied text from a platform we do not control: somebody whose IM
 * nickname is their phone number would otherwise silently kill every
 * auto-reply in that group.
 *
 * So a label is only used when it survives `redactText` + `hasNoLeakingPii`.
 * Otherwise the speaker falls back to a stable pseudonym. That is the same
 * shape `lib/claude/team-primary-router.ts` already uses for roster tokens
 * (`A1` / `A2` + `redactText` + `hasNoLeakingPii`), applied here per
 * participant instead of per team member.
 *
 * # Display names are an injection surface
 *
 * The label is interpolated into a rendered transcript (`Alice: hello`) and
 * into a bracketed prompt header. A nickname containing a newline could forge
 * a transcript line, and one containing `]` could close the header early. So
 * `sanitizeSpeakerLabel` strips line breaks, control characters, brackets and
 * leading markdown structure, and caps the length. Those rules are pinned by
 * tests, not left to the caller.
 *
 * # Absent attribution stays absent
 *
 * `resolveMessageSpeaker` returns `null` when a message carries no
 * distinguishing authorship. Callers keep whatever they wrote before, so a
 * one-human local conversation is byte-for-byte unchanged.
 */

import { hasNoLeakingPii, redactText } from "@cognia/redact"
import type { AuthorKind, AuthorRef } from "@cognia/agent-config-types"
import type { PlatformIdentity } from "@/types/connectors/event"

/**
 * Speaker classes. A superset of `AuthorKind` is deliberately NOT introduced:
 * this is the same vocabulary `packages/agent-config-types/src/collaboration.ts`
 * already publishes, so a shared-session author maps across without a table.
 */
export type SpeakerKind = AuthorKind

export interface MessageSpeaker {
  kind: SpeakerKind
  /** `usr_…` | platform identity id | characterId. Stable, and never rendered raw into a prompt. */
  id: string
  /** Prompt-safe display label. Equals `handle` when the raw name could not be cleared. */
  label: string
  /** Stable pseudonym derived from `id`. Always prompt-safe, always available. */
  handle: string
  /** True when `label` fell back to `handle` (raw name absent, unsafe, or empty after sanitizing). */
  redacted: boolean
}

/** The message-shaped fields this resolver reads. Structural, so `StoredMessage` and `UIMessage` both fit. */
export interface SpeakerSource {
  role?: string
  senderId?: string
  collaboration?: { author?: AuthorRef } | undefined
  metadata?: Record<string, unknown> | undefined
}

export interface SpeakerContext {
  /** `characterId` to display name, for team-session assistant turns. */
  characterNameById?: ReadonlyMap<string, string> | undefined
}

/**
 * Longest label kept. Some platforms allow very long nicknames, and a prompt
 * line is not the place for them.
 */
export const MAX_SPEAKER_LABEL_LENGTH = 48

/** Placeholders `redactText` emits, e.g. `<EMAIL_001>`. */
const REDACTION_PLACEHOLDER_RE = /<[A-Z_]+_\d{3,}>/g

/**
 * Characters that would let an attacker-chosen nickname forge structure in a
 * rendered transcript or in the bracketed prompt header: line breaks and
 * separators, C0/C1 controls, and the brackets that bound the header.
 */
const STRUCTURE_BREAKING_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029[\]]/g

/** Markdown structure a label must not start with, so it cannot forge a heading or list item. */
const LEADING_MARKDOWN_RE = /^[#>*\-+=|`~\s]+/

/**
 * Strip everything that could forge structure, collapse whitespace, and cap
 * the length. Returns `""` when nothing usable survives.
 */
export function sanitizeSpeakerLabel(raw: string): string {
  const flattened = raw.replace(STRUCTURE_BREAKING_RE, " ")
  const collapsed = flattened.replace(/\s+/g, " ")
  const unprefixed = collapsed.replace(LEADING_MARKDOWN_RE, "")
  // A trailing colon would render as `Alice:: text` in the transcript.
  const trimmed = unprefixed.replace(/[\s:\uff1a]+$/, "").trim()
  return trimmed.slice(0, MAX_SPEAKER_LABEL_LENGTH).trim()
}

/**
 * A stable, prompt-safe pseudonym for `id`. Deterministic and stateless, so
 * the same participant reads the same way across turns, devices and hosts
 * without anything having to remember an index.
 */
export function speakerHandle(kind: SpeakerKind, id: string): string {
  return `${handlePrefix(kind)}-${stableSuffix(id)}`
}

function handlePrefix(kind: SpeakerKind): string {
  switch (kind) {
    case "agent":
      return "Agent"
    case "app":
    case "connector":
      return "App"
    case "system":
      return "System"
    case "guest":
      return "Guest"
    case "human":
    default:
      return "Person"
  }
}

/** Base-36 characters kept from the hash. 36^6 buckets, short enough to read in a prompt line. */
const HANDLE_SUFFIX_LENGTH = 6

/**
 * FNV-1a followed by the MurmurHash3 finalizer.
 *
 * The avalanche step is not decoration. A plain `hash * 31 + c` rolling hash
 * leaves adjacent ids (`tg:1`, `tg:2`) sharing every high-order base-36 digit,
 * so truncating the front of it handed two different people the same handle.
 * Mixing first, then keeping the LOW digits, is what makes ids that differ by
 * one character land in unrelated buckets.
 */
function stableSuffix(id: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < id.length; i++) {
    hash ^= id.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  hash ^= hash >>> 16
  hash = Math.imul(hash, 0x85ebca6b)
  hash ^= hash >>> 13
  hash = Math.imul(hash, 0xc2b2ae35)
  hash ^= hash >>> 16
  return (hash >>> 0)
    .toString(36)
    .toUpperCase()
    .padStart(HANDLE_SUFFIX_LENGTH, "0")
    .slice(-HANDLE_SUFFIX_LENGTH)
}

/**
 * Clear a raw display name for prompt use, or fall back to `handle`.
 *
 * Exported because the roster builder labels participants that are not
 * attached to any one message.
 */
export function safeSpeakerLabel(
  rawName: string | undefined,
  kind: SpeakerKind,
  id: string
): { label: string; handle: string; redacted: boolean } {
  const handle = speakerHandle(kind, id)
  const raw = (rawName ?? "").trim()
  if (!raw) return { label: handle, handle, redacted: true }

  // Redact first, then drop the placeholders: `Alice <alice@corp.com>` should
  // read as `Alice`, not as `Alice <EMAIL_001>`.
  const cleared = redactText(raw).redacted.replace(REDACTION_PLACEHOLDER_RE, " ")
  const label = sanitizeSpeakerLabel(cleared)
  if (!label) return { label: handle, handle, redacted: true }
  // Belt and braces: the gate that will actually run at send time.
  if (!hasNoLeakingPii(label)) return { label: handle, handle, redacted: true }
  return { label, handle, redacted: label !== raw }
}

/**
 * Build a speaker from an identity that is not attached to a message: a team's
 * declared members, a shared session's membership rows, an IM group's roster.
 */
export function makeSpeaker(
  kind: SpeakerKind,
  id: string,
  rawName?: string | undefined
): MessageSpeaker {
  const { label, handle, redacted } = safeSpeakerLabel(rawName, kind, id)
  return { kind, id, label, handle, redacted }
}

/**
 * The speaker behind an inbound IM event's sender.
 *
 * Separate from {@link resolveMessageSpeaker} because the connector runtime
 * holds a `NormalizedInboundEvent` before any message row exists, and because
 * `PlatformIdentity.kind` is the only place a sibling bot is distinguishable
 * from a person.
 */
export function speakerFromPlatformIdentity(sender: PlatformIdentity): MessageSpeaker {
  return makeSpeaker(speakerKindOfPlatformSender(sender.kind), sender.id, sender.displayName)
}

/**
 * Resolve who authored `source`, or `null` when the message carries no
 * distinguishing authorship (a plain local one-human conversation).
 *
 * Order, strongest first:
 *   1. `collaboration.author`, a shared session's server-assigned `AuthorRef`.
 *   2. `metadata.platformMessage.sender`, the IM sender the adapter parsed.
 *   3. `senderId`, the character that spoke a team-session assistant turn.
 *
 * `lib/db/messages.ts` hoists `senderId` into `metadata` for the UI layer, so
 * both placements are read.
 */
export function resolveMessageSpeaker(
  source: SpeakerSource,
  ctx: SpeakerContext = {}
): MessageSpeaker | null {
  const metadata = source.metadata

  const author = source.collaboration?.author ?? collaborationAuthorFromMetadata(metadata)
  if (author?.id) {
    const { label, handle, redacted } = safeSpeakerLabel(author.displayName, author.kind, author.id)
    return { kind: author.kind, id: author.id, label, handle, redacted }
  }

  const sender = platformSenderFromMetadata(metadata)
  if (sender?.id) {
    const kind = speakerKindOfPlatformSender(sender.kind)
    const { label, handle, redacted } = safeSpeakerLabel(sender.displayName, kind, sender.id)
    return { kind, id: sender.id, label, handle, redacted }
  }

  const senderId = source.senderId ?? stringField(metadata, "senderId")
  if (senderId) {
    const kind: SpeakerKind = source.role === "user" ? "human" : "agent"
    const name = ctx.characterNameById?.get(senderId)
    const { label, handle, redacted } = safeSpeakerLabel(name, kind, senderId)
    return { kind, id: senderId, label, handle, redacted }
  }

  return null
}

function speakerKindOfPlatformSender(kind: PlatformIdentity["kind"]): SpeakerKind {
  if (kind === "bot") return "app"
  if (kind === "system") return "system"
  return "human"
}

function collaborationAuthorFromMetadata(
  metadata: Record<string, unknown> | undefined
): AuthorRef | undefined {
  const collaboration = objectField(metadata, "collaboration")
  const author = objectField(collaboration, "author")
  if (!author) return undefined
  const id = stringField(author, "id")
  const kind = stringField(author, "kind")
  if (!id || !isSpeakerKind(kind)) return undefined
  const displayName = stringField(author, "displayName")
  return { kind, id, ...(displayName ? { displayName } : {}) }
}

function platformSenderFromMetadata(
  metadata: Record<string, unknown> | undefined
): PlatformIdentity | undefined {
  const platformMessage = objectField(metadata, "platformMessage")
  const sender = objectField(platformMessage, "sender")
  if (!sender) return undefined
  if (!stringField(sender, "id")) return undefined
  return sender as unknown as PlatformIdentity
}

const SPEAKER_KINDS: readonly string[] = ["human", "guest", "agent", "app", "connector", "system"]

function isSpeakerKind(value: string | undefined): value is SpeakerKind {
  return value !== undefined && SPEAKER_KINDS.includes(value)
}

function objectField(
  source: Record<string, unknown> | undefined,
  key: string
): Record<string, unknown> | undefined {
  const value = source?.[key]
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function stringField(source: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = source?.[key]
  return typeof value === "string" && value.length > 0 ? value : undefined
}

/**
 * How a speaker is named inside a rendered transcript line
 * (`Alice · Person-1A2B: hi`).
 *
 * The handle rides along with the label because two people in one group can
 * share a nickname, and because it is the key the roster section joins on.
 * When the label already IS the handle there is nothing to append.
 */
export function speakerTranscriptName(speaker: MessageSpeaker): string {
  return speaker.redacted ? speaker.handle : `${speaker.label} \u00b7 ${speaker.handle}`
}

/**
 * The one-line header prepended to an inbound group message so the model can
 * tell participants apart.
 *
 * Bracketed and bounded: `sanitizeSpeakerLabel` has already removed `[`, `]`
 * and every line break, so a chosen nickname cannot close the bracket or open
 * a second header.
 */
export function speakerPromptHeader(speaker: MessageSpeaker): string {
  return `[speaker: ${speakerTranscriptName(speaker)}]`
}

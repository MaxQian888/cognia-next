import type { SegmentType } from "./segment"

export const ALL_CAPABILITIES = [
  // send.*
  "send.text",
  "send.markdown",
  "send.html",
  "send.image",
  "send.voice",
  "send.video",
  "send.file",
  "send.card",
  "send.poll",
  "send.location",
  "send.reply",
  "send.emoji",
  "send.mention",
  "send.thread",
  "send.reaction",
  // A2UI projection capability — declared when the adapter implements
  // `a2uiCapability()` and can serialise at least one A2UI component type
  // natively. The detailed per-component matrix lives in
  // `A2UICapabilityMatrix`; this flag is just the boolean rollup used by
  // policy / build-options.
  "send.a2ui",
  // mutations
  "edit",
  "delete",
  "typing",
  "history.fetch",
  // presence — the adapter can surface a short, periodically refreshed
  // status text next to a user/bot identity (Lark 系统状态 badge, Slack
  // users.profile.set, Discord gateway presence). Declared when the
  // adapter implements `setPresenceStatus()`.
  "presence.status",
  // The adapter can pin a message so a periodically edited card stays
  // visible at the top of a conversation (`pinMessage()`).
  "pin",
  // Chat management (W2 multi-bot) — declared when the adapter implements
  // the matching optional `PlatformAdapter` method. These flags gate the
  // platform-neutral `im.*` built-in skills via `requires:` in the skill
  // manifest, so incapable platforms simply never surface the tools.
  //   - `chat.create`     — `createChat()` (make a new group chat)
  //   - `chat.members`    — `addChatMembers()` + `removeChatMembers()`
  //   - `chat.update`     — `updateChat()` (rename / description)
  //   - `contact.resolve` — `resolveContacts()` (email/phone/name → member id)
  "chat.create",
  "chat.members",
  "chat.update",
  "contact.resolve",
  // platform-specific rich content (escape hatches)
  "rich-markdown.telegram",
  "rich-markdown.slack",
  "rich-card.lark",
  "rich-card.slack",
] as const

export type Capability = (typeof ALL_CAPABILITIES)[number]

export function hasCapability(flags: readonly Capability[], cap: Capability): boolean {
  return flags.includes(cap)
}

/**
 * The exhaustive set of A2UI component kinds the bus can reason about. Kept
 * as a typed string union (not `string`) so each adapter's
 * `a2uiCapability()` table is statically checked against the catalogue.
 *
 * Mirror of `A2UIComponentType` minus the `string` escape hatch — the
 * catch-all is fine for the renderer (lets plugins add custom kinds), but
 * the bus must enumerate what every adapter declares so build-options can
 * tell the assistant which kinds will degrade.
 */
export const A2UI_COMPONENT_KINDS = [
  // Display
  "Text",
  "Image",
  "Icon",
  "Link",
  "Divider",
  "Spacer",
  "Badge",
  "Alert",
  "Animation",
  "RichOutput",
  // Form controls
  "Button",
  "TextField",
  "TextArea",
  "Select",
  "Checkbox",
  "Radio",
  "RadioGroup",
  "Slider",
  "DatePicker",
  "TimePicker",
  "DateTimePicker",
  // Layout
  "Card",
  "Row",
  "Column",
  "List",
  "Dialog",
  "Tabs",
  "Accordion",
  "Drawer",
  "Sheet",
  "Sidebar",
  "Collapsible",
  // Data
  "Table",
  "Chart",
  "Pagination",
  // Misc
  "Progress",
  "InteractiveGuide",
] as const

export type A2UIComponentKind = (typeof A2UI_COMPONENT_KINDS)[number]

/**
 * How an adapter intends to handle a specific A2UI component kind.
 *
 *   - `native`      — the platform renders the component natively and the
 *                     interaction is synchronous from the user's point of
 *                     view (Slack button block, Lark card datepicker, etc.).
 *   - `simulated`   — the platform CAN deliver the interaction but only
 *                     through a multi-step UX (Telegram ForceReply for
 *                     TextField, Discord modal double-hop for forms, NapCat
 *                     QQ markdown card for OneBot buttons). The component
 *                     is functional, but the assistant must not assume a
 *                     synchronous reply on the same turn — the user might
 *                     dismiss the modal, take time to type, etc.
 *   - `fallback`    — the platform cannot render it but the adapter will
 *                     project it into `plainTextMirror` so semantics survive.
 *   - `unsupported` — the platform cannot render and the adapter cannot
 *                     fallback (e.g., interactive Charts on OneBot). The
 *                     assistant SHOULD NOT generate this kind on this
 *                     platform; the build-options capability prompt warns it.
 *
 * Worst-case ordering for `CapabilityEvaluation.worstCase`:
 *   `unsupported > fallback > simulated > native`.
 */
export type A2UIComponentSupport = "native" | "simulated" | "fallback" | "unsupported"

export type A2UICapabilityMatrix = Readonly<Record<A2UIComponentKind, A2UIComponentSupport>>

/**
 * Build a capability matrix from a partial table — every component kind not
 * mentioned defaults to `fallback`, matching the assistant-side promise that
 * unsupported components degrade to plain text rather than vanish.
 */
export function buildA2UICapabilityMatrix(
  partial: Partial<Record<A2UIComponentKind, A2UIComponentSupport>>
): A2UICapabilityMatrix {
  const out: Record<A2UIComponentKind, A2UIComponentSupport> = {} as Record<
    A2UIComponentKind,
    A2UIComponentSupport
  >
  for (const kind of A2UI_COMPONENT_KINDS) {
    out[kind] = partial[kind] ?? "fallback"
  }
  return Object.freeze(out)
}

/**
 * Convenience: list every component kind with a given support level.
 * Used by build-options to inject a Markdown bullet list of native /
 * fallback / unsupported kinds into the system prompt.
 */
export function componentKindsByLevel(
  matrix: A2UICapabilityMatrix,
  level: A2UIComponentSupport
): A2UIComponentKind[] {
  const out: A2UIComponentKind[] = []
  for (const kind of A2UI_COMPONENT_KINDS) {
    if (matrix[kind] === level) out.push(kind)
  }
  return out
}

/**
 * Default per-segment-type degradation order. Each adapter MAY override via
 * its own degrade table; this is the conservative default. The bus walks
 * the chain from index 0 onward, picking the first segment type whose
 * `send.<type>` capability the adapter declares.
 */
export function defaultDegradeChain(from: SegmentType): SegmentType[] {
  switch (from) {
    case "card":
      return ["card", "markdown", "text"]
    case "markdown":
      return ["markdown", "text"]
    case "image":
    case "video":
    case "voice":
    case "file":
      return [from, "text"]
    case "emoji":
    case "mention":
    case "reply":
    case "location":
    case "poll":
    case "code":
      return [from, "text"]
    case "a2ui":
      // A2UI segments carry a `plainTextMirror`; falling back to a plain
      // text segment is always safe even when the adapter implements no
      // native projection. `card` sits between because some platforms
      // (Lark, Slack) can wrap a degraded surface in a generic card.
      return ["a2ui", "card", "markdown", "text"]
    case "text":
    default:
      return ["text"]
  }
}

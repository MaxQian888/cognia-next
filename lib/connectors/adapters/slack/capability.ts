import {
  buildA2UICapabilityMatrix,
  type A2UICapabilityMatrix,
  type Capability,
} from "@/types/connectors/capability"

/**
 * Phase-1 capability flags declared by the Slack adapter.
 *
 * Kept in alphabetical order for stable diffs.
 *
 * Notes:
 *  - typing: gated on adapter option `assistantAppEnabled`. When the
 *    Slack app is registered as an Assistant App (beta), the adapter
 *    issues `assistant.threads.setStatus` from `setTyping(...)` — the
 *    capability is always advertised, but the adapter no-ops the call
 *    when the option is off so non-assistant bots don't 403. Added at
 *    ADR-0009 v41 / A3.
 *  - rich-card.slack: Block Kit opaque payload passthrough
 *  - rich-markdown.slack: Slack mrkdwn dialect
 */
export const SLACK_CAPS: readonly Capability[] = [
  "delete",
  "edit",
  "history.fetch",
  "rich-card.slack",
  "rich-markdown.slack",
  "send.a2ui",
  "send.card",
  "send.file",
  "send.image",
  "send.markdown",
  "send.mention",
  "send.reaction",
  "send.reply",
  "send.text",
  "send.thread",
  "typing",
] as const

/**
 * A2UI capability matrix for the Slack adapter (G3.3).
 *
 * Block Kit covers the richest A2UI surface of the five platforms. The
 * native set is everything `buildSlackA2UIBlocks` can render as a
 * section / actions / input / header / image / divider block plus
 * pseudo-native mrkdwn variants.
 *
 * Components NOT supported natively (`fallback`, render via plain text
 * mirror):
 *   - Slider (no native Block Kit element).
 *   - Table / Chart / DataExplorer / Pagination.
 *   - Tabs / Accordion / Drawer / Sheet / Sidebar / Collapsible —
 *     no native equivalent; assistant should structure content with
 *     dividers + headers instead.
 *   - Animation / RichOutput / InteractiveGuide.
 */
export const SLACK_A2UI_CAPABILITY: A2UICapabilityMatrix = buildA2UICapabilityMatrix({
  Text: "native",
  Image: "native",
  Link: "native",
  Divider: "native",
  Card: "native",
  Alert: "native",
  Button: "native",
  Select: "native",
  RadioGroup: "native",
  Checkbox: "native",
  TextField: "native",
  TextArea: "native",
  DatePicker: "native",
  TimePicker: "native",
  Row: "native",
  Column: "native",
  List: "native",
  // Simulated tier (ADR-0009 v41 / B6) — these have no native Block Kit
  // equivalent but can be stood in with quantised select / header+section
  // / toggle button patterns. The mapper can opt in to emit these
  // stand-ins; the assistant is warned via the capability prompt that
  // they're multi-step UX (e.g., switching tab content requires a click +
  // a follow-up message).
  Slider: "simulated",
  Tabs: "simulated",
  Accordion: "simulated",
})

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
 *  - send.typing: no native typing on bot APIs in Phase 1
 *    (assistant.threads.setStatus requires the assistants beta)
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
})

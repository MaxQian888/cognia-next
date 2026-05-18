import {
  buildA2UICapabilityMatrix,
  type A2UICapabilityMatrix,
  type Capability,
} from "@/types/connectors/capability"

/**
 * Phase-1 capability flags declared by the Telegram adapter.
 *
 * Kept in alphabetical order for stable diffs.
 */
/**
 * Note on `history.fetch`: Telegram's Bot API does not expose any endpoint
 * for fetching arbitrary message history from a chat. `getUpdates` only
 * returns pending updates, and `getChat`/`getChatHistory` are not available
 * to bots. Declaring `history.fetch` would be dishonest, so it is omitted.
 */
export const TELEGRAM_CAPS: readonly Capability[] = [
  "delete",
  "edit",
  "rich-markdown.telegram",
  "send.a2ui",
  "send.file",
  "send.image",
  "send.markdown",
  "send.mention",
  "send.reply",
  "send.text",
  "send.thread",
  "send.video",
  "send.voice",
  "typing",
] as const

/**
 * A2UI capability matrix for the Telegram adapter (G3.1).
 *
 * Native rendering coverage:
 *   - Text / Link / Divider / Card / Alert: rendered as MarkdownV2 in
 *     a sendMessage with `parse_mode: "MarkdownV2"`. Card titles become
 *     bold; Alerts become `⚠️ *Title*: body`.
 *   - Image: rendered as a separate `sendPhoto` call.
 *   - Button / ButtonGroup: rendered as `InlineKeyboardMarkup` attached
 *     to the body sendMessage. Per-button bindings live in
 *     `connectorCallbackBindings` so the SHA-1-truncated wire id
 *     round-trips through Telegram's 64-byte `callback_data` cap.
 *   - Row / Column / List: layout-only; the mapper walks children.
 *
 * Components NOT supported natively (`fallback`) — assistant remains
 * free to emit them; they render via `plainTextMirror`:
 *   - Form controls (TextField / TextArea / Select / Checkbox / Radio /
 *     RadioGroup / Slider / DatePicker / TimePicker / DateTimePicker).
 *   - Data widgets (Table / Chart / DataExplorer / Pagination).
 *   - Overlay widgets (Tabs / Accordion / Dialog / Drawer / Sheet /
 *     Sidebar / Collapsible).
 */
export const TELEGRAM_A2UI_CAPABILITY: A2UICapabilityMatrix = buildA2UICapabilityMatrix({
  Text: "native",
  Image: "native",
  Link: "native",
  Divider: "native",
  Card: "native",
  Alert: "native",
  Button: "native",
  Row: "native",
  Column: "native",
  List: "native",
})

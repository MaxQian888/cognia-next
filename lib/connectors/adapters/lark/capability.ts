import {
  buildA2UICapabilityMatrix,
  type A2UICapabilityMatrix,
  type Capability,
} from "@/types/connectors/capability"

/**
 * Capability flags declared by the Lark adapter.
 *
 * Kept in alphabetical order for stable diffs.
 *
 * Notes:
 *  - send.typing: Lark has no native typing indicator for bots.
 *  - rich-card.lark: Lark interactive card (im v1 cards 2.0).
 *  - history.fetch: /im/v1/messages list with cursor pagination.
 *  - send.voice / send.video / send.file / send.image: handled by
 *    `lark/upload.ts` which runs an async upload pre-pass on outbound,
 *    resolving remote URLs to Lark `file_key` / `image_key` via
 *    `connectors_lark_upload_file` / `connectors_lark_upload_image` Tauri
 *    commands. Already-resolved keys (no `://` in the URL) skip the
 *    upload.
 */
export const LARK_CAPS: readonly Capability[] = [
  "delete",
  "edit",
  "history.fetch",
  "rich-card.lark",
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
  "send.video",
  "send.voice",
] as const

/**
 * A2UI capability matrix for the Lark adapter (G3.4).
 *
 * Native rendering (via `buildLarkA2UICard`):
 *   - Text / Link / Divider / Card (header) / Alert → div+lark_md / hr.
 *   - Image → `img` (when the URL is already a Lark file_key).
 *   - Button / ButtonGroup → `action[].button` with callback bindings.
 *   - Select / RadioGroup → `action[].select_static`.
 *   - DatePicker / TimePicker → `action[].picker_date` / `picker_time`.
 *   - TextField / TextArea → `input` element (rows=4 for TextArea).
 *   - Row / Column / List → layout-only.
 *
 * Fallback (renders via plain text mirror):
 *   - Checkbox (Lark cards have no single-checkbox element).
 *   - Slider / Table / Chart / DataExplorer / Pagination.
 *   - Tabs / Accordion / Dialog / Drawer / Sheet / Sidebar / Collapsible.
 */
export const LARK_A2UI_CAPABILITY: A2UICapabilityMatrix = buildA2UICapabilityMatrix({
  Text: "native",
  Image: "native",
  Link: "native",
  Divider: "native",
  Card: "native",
  Alert: "native",
  Button: "native",
  Select: "native",
  RadioGroup: "native",
  TextField: "native",
  TextArea: "native",
  DatePicker: "native",
  TimePicker: "native",
  Row: "native",
  Column: "native",
  List: "native",
})

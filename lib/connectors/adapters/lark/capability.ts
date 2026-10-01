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
  // Chat management (W2 multi-bot): implemented by
  // `lark/chat-management.ts` over /im/v1/chats + /contact/v3 — paired with
  // the optional PlatformAdapter methods wired in `lark/index.ts`.
  "chat.create",
  "chat.members",
  "chat.update",
  "contact.resolve",
  "delete",
  "edit",
  // forward + merge_forward via `POST /im/v1/messages/:id/forward` and
  // `/im/v1/messages/merge_forward` (lark/index.ts `forwardMessage`).
  "forward",
  "history.fetch",
  "pin",
  "presence.status",
  "rich-card.lark",
  "send.a2ui",
  "send.card",
  "send.ephemeral",
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
  // 加急 (urgent) via `PATCH /im/v1/messages/:id/urgent_{app,sms,phone}`
  // (lark/index.ts `sendUrgent`). Implemented but requires the elevated
  // `im:message.urgent*` scope; a bot without it surfaces a scope error.
  "urgent",
] as const

/**
 * Card 2.0 native display and form controls. Multi-select uses a form
 * submission; Dialog/Drawer/Sheet remain titled inline sections rather
 * than modal overlays. Table/Chart render their data natively, while
 * app-specific row selection/sorting/chart-click actions remain unavailable.
 * Unsupported/deeply nested layouts preserve a readable text projection.
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
  Checkbox: "native",
  DateTimePicker: "native",
  FormGroup: "native",
  Collapsible: "native",
  Table: "simulated",
  Chart: "simulated",
  // Overlays render inline as titled sections (divider + bold title +
  // children); native form_dialog overlays are not projected from A2UI.
  Dialog: "simulated",
  Drawer: "simulated",
  Sheet: "simulated",
})

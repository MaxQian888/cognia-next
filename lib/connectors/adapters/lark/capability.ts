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
 * A2UI capability matrix for the Lark adapter (G3.4, extended at ADR-0009
 * v41 / B4 for Checkbox simulated tier; Dialog / Drawer / Sheet render as
 * inline titled sections — the mapper emits card JSON 1.0 which has no
 * modal runtime and never emits Card 2.0 `form_dialog` containers).
 *
 * Native rendering (via `buildLarkA2UICard`):
 *   - Text / Link / Divider / Card (header) / Alert → div+lark_md / hr.
 *   - Image → `img` (when the URL is already a Lark file_key).
 *   - Button / ButtonGroup → `action[].button` with callback bindings.
 *   - Select / RadioGroup → `action[].select_static`.
 *   - DatePicker / TimePicker → `action[].picker_date` / `picker_time`.
 *   - TextField / TextArea → `input` inside an `action` module (the
 *     message-card schema rejects root-level inputs; TextArea renders as
 *     the same single-line input — there is no rows prop).
 *   - Row / Column / List → layout-only.
 *
 * Simulated (functional but multi-step UX, or stand-in component):
 *   - Checkbox → two-option `select_static` ("✓" / "✗") labelled with
 *     the field name. Lark interactive cards 2.0 have no native single-
 *     checkbox element, so the mapper renders the component as a
 *     `select_static` with two options + `simulatedCheckbox: true` on
 *     the wire value. `parseLarkInteractiveCallback` lifts the event
 *     back into `actionType: "checkbox"` with a canonical "true" /
 *     "false" string so the A2UI bridge sees the same shape as on
 *     platforms with native checkbox support. The user-visible UX is
 *     "tap the dropdown, pick ✓ or ✗" — single round-trip but two
 *     visible steps, hence simulated.
 *   - Dialog / Drawer / Sheet → inline section projection. Lark v1
 *     interactive cards have no modal/drawer runtime, so the mapper
 *     renders the overlay as a divider + bold title followed by its
 *     children inline (TextField / Select / DatePicker / Button all keep
 *     their individual callback bindings). The overlay semantics degrade
 *     to "titled form section in the same card" — functional but not an
 *     actual overlay, hence simulated. The mapper never emits Card 2.0
 *     form containers, so `form_value` submits only arrive from cards
 *     produced elsewhere; when they do, `parseLarkInteractiveCallback`
 *     lifts them to `actionType: "submit"`.
 *
 * Fallback (renders via plain text mirror):
 *   - Slider / Table / Chart / Pagination.
 *   - Tabs / Accordion / Sidebar / Collapsible.
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
  Checkbox: "simulated",
  // Overlays render inline as titled sections (divider + bold title +
  // children); card JSON 1.0 has no modal / form_dialog runtime.
  Dialog: "simulated",
  Drawer: "simulated",
  Sheet: "simulated",
})

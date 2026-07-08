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
] as const

/**
 * A2UI capability matrix for the Lark adapter (G3.4, extended at ADR-0009
 * v41 / B4 for Checkbox simulated tier, extended again at ADR-0026 for
 * `form_dialog` Modal projection).
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
 *   - Dialog / Drawer / Sheet → Lark Interactive Card v2 `form_dialog`
 *     element (ADR-0026 Track B). The mapper emits a Button that, when
 *     clicked, opens a Lark `form_dialog` carrying the surface's
 *     TextField / Select / DatePicker children. Callback round-trips
 *     through the `connectorCallbackBindings` table with
 *     `kind: "modal_open"` so the bus knows to project the submit
 *     payload back as `actionType: "submit"`.
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
  // ADR-0026 Track B — overlays projected as Lark form_dialog two-hop.
  Dialog: "simulated",
  Drawer: "simulated",
  Sheet: "simulated",
})
